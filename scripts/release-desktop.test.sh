#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/pr-visualizer-release-test.XXXXXX")"
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT

TEST_ROOT="$TEMPORARY_DIRECTORY/repo"
MOCK_BIN="$TEMPORARY_DIRECTORY/bin"
TRACE="$TEMPORARY_DIRECTORY/trace"
mkdir -p "$TEST_ROOT/scripts" "$MOCK_BIN"
cp "$PROJECT_ROOT/scripts/release-desktop.sh" "$TEST_ROOT/scripts/"
cp "$PROJECT_ROOT/scripts/copy-dmg-to-icloud.sh" "$TEST_ROOT/scripts/"
chmod +x "$TEST_ROOT/scripts/release-desktop.sh" "$TEST_ROOT/scripts/copy-dmg-to-icloud.sh"

write_mock() {
  local name="$1"
  local body="$2"
  local path="$MOCK_BIN/$name"

  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' "$body" > "$path"
  chmod +x "$path"
}

write_mock pnpm 'mkdir -p "$RELEASE_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/PR Visualizer.app/Contents/MacOS"; : > "$RELEASE_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/PR Visualizer.app/Contents/MacOS/pr-visualizer"; echo "pnpm build" >> "$TRACE"'
write_mock codesign 'echo "codesign $*" >> "$TRACE"; if [[ "$*" == *"-dvv"* ]]; then printf "Authority=Developer ID Application: Surachet Sangasaeng (T75BTQ2WL9)\\nTeamIdentifier=T75BTQ2WL9\\nflags=0x10000(runtime)\\n"; fi'
write_mock xcrun 'echo "xcrun $*" >> "$TRACE"; if [[ "${FAIL_DMG_VALIDATION:-0}" = "1" && "$*" == *"stapler validate"* && "$*" == *".dmg"* ]]; then exit 45; fi'
write_mock spctl 'echo "spctl $*" >> "$TRACE"'
write_mock ditto 'echo "ditto $*" >> "$TRACE"; target="${!#}"; mkdir -p "$(dirname "$target")"; : > "$target"'
write_mock hdiutil 'echo "hdiutil $*" >> "$TRACE"; target="${!#}"; mkdir -p "$(dirname "$target")"; : > "$target"'
write_mock PlistBuddy 'printf "0.7.2\\n"'
write_mock lipo 'printf "arm64\\n"'

run_release() {
  local trace_path="$1"
  shift
  local publish_directory="${trace_path}.icloud"

  TRACE="$trace_path" \
    RELEASE_ROOT="$TEST_ROOT" \
    PNPM_BIN="$MOCK_BIN/pnpm" \
    CODESIGN_BIN="$MOCK_BIN/codesign" \
    XCRUN_BIN="$MOCK_BIN/xcrun" \
    SPCTL_BIN="$MOCK_BIN/spctl" \
    DITTO_BIN="$MOCK_BIN/ditto" \
    HDIUTIL_BIN="$MOCK_BIN/hdiutil" \
    PLIST_BUDDY_BIN="$MOCK_BIN/PlistBuddy" \
    LIPO_BIN="$MOCK_BIN/lipo" \
    ICLOUD_DIR="$publish_directory" \
    "$@" "$TEST_ROOT/scripts/release-desktop.sh"
}

line_number() {
  local pattern="$1"
  local trace_path="$2"

  grep -n -m 1 -- "$pattern" "$trace_path" | cut -d: -f1
}

assert_before() {
  local earlier="$1"
  local later="$2"
  local trace_path="$3"
  local earlier_line
  local later_line
  earlier_line="$(line_number "$earlier" "$trace_path")"
  later_line="$(line_number "$later" "$trace_path")"

  [[ "$earlier_line" -lt "$later_line" ]] || {
    echo "expected '$earlier' before '$later'" >&2
    exit 1
  }
}

# Arrange
SUCCESS_TRACE="$TEMPORARY_DIRECTORY/success-trace"

# Act
run_release "$SUCCESS_TRACE" env

# Assert
assert_before 'pnpm build' 'notarytool submit .*app.zip' "$SUCCESS_TRACE"
assert_before 'notarytool submit .*app.zip' 'stapler staple .*PR Visualizer.app' "$SUCCESS_TRACE"
assert_before 'stapler validate .*PR Visualizer.app' 'hdiutil create' "$SUCCESS_TRACE"
assert_before 'hdiutil create' 'notarytool submit .*\.dmg' "$SUCCESS_TRACE"
assert_before 'notarytool submit .*\.dmg' 'stapler validate .*\.dmg' "$SUCCESS_TRACE"
assert_before 'stapler validate .*\.dmg' 'ditto .*PR Visualizer_0.7.2' "$SUCCESS_TRACE"
grep -q 'PR Visualizer_0.7.2_aarch64.dmg' "$SUCCESS_TRACE"
if grep -q 'PR Visualizer_0.7.2_arm64.dmg' "$SUCCESS_TRACE"; then
  echo 'Apple silicon artifacts must use the established aarch64 suffix' >&2
  exit 1
fi

# Arrange
FAILURE_TRACE="$TEMPORARY_DIRECTORY/failure-trace"

# Act
if run_release "$FAILURE_TRACE" env FAIL_DMG_VALIDATION=1; then
  echo 'expected DMG validation failure' >&2
  exit 1
fi

# Assert
if [ -e "$FAILURE_TRACE.icloud/PR Visualizer_0.7.2_aarch64.dmg" ]; then
  echo 'failed DMG validation must prevent publishing' >&2
  exit 1
fi

echo 'release-desktop tests passed'
