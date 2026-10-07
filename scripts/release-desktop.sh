#!/usr/bin/env bash
# Produces the only distributable desktop artifact: Developer ID signed,
# notarized, stapled, Gatekeeper-validated, and then published to iCloud.
set -euo pipefail

ROOT="${RELEASE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
APP_NAME="${APP_NAME:-PR Visualizer}"
PRODUCT_PREFIX="${PRODUCT_PREFIX:-PR Visualizer}"
DEV_ID="${DEV_ID:-Developer ID Application: Surachet Sangasaeng (T75BTQ2WL9)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-MemiosCamNotary}"
APP_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DMG_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle/dmg"
PNPM_BIN="${PNPM_BIN:-pnpm}"
CODESIGN_BIN="${CODESIGN_BIN:-codesign}"
XCRUN_BIN="${XCRUN_BIN:-xcrun}"
SPCTL_BIN="${SPCTL_BIN:-spctl}"
DITTO_BIN="${DITTO_BIN:-ditto}"
HDIUTIL_BIN="${HDIUTIL_BIN:-hdiutil}"
PLIST_BUDDY_BIN="${PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"
LIPO_BIN="${LIPO_BIN:-lipo}"

fail() {
  echo "error: $*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$*"
}

require_developer_id_signature() {
  local signature
  signature="$($CODESIGN_BIN -dvv "$APP_DIR" 2>&1)"

  [[ "$signature" == *"Authority=Developer ID Application"* ]] || fail "app is not Developer ID signed"
  [[ "$signature" == *"TeamIdentifier=T75BTQ2WL9"* ]] || fail "app is not signed by team T75BTQ2WL9"
  [[ "$signature" == *"runtime"* ]] || fail "app does not enable the hardened runtime"
}

require_safe_entitlements() {
  local entitlements
  entitlements="$($CODESIGN_BIN -d --entitlements :- "$APP_DIR" 2>/dev/null || true)"

  [[ "$entitlements" != *"com.apple.security.get-task-allow"* ]] || fail "app contains the disallowed get-task-allow entitlement"
}

verify_app_signature() {
  "$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$APP_DIR"
  require_developer_id_signature
  require_safe_entitlements
}

main() {
  cd "$ROOT"

  # Fail before spending build time if the local keychain profile is unavailable.
  "$XCRUN_BIN" notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null

  # Tauri owns bundle signing. Keep its automatic notarization disabled here so
  # this script can staple the app before it is placed in the distributed DMG.
  step "Build Developer ID signed app"
  env -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH \
    -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
    APPLE_SIGNING_IDENTITY="$DEV_ID" \
    CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
    "$PNPM_BIN" --filter @pr-visulizer/desktop tauri build --bundles app

  [[ -d "$APP_DIR" ]] || fail "signed app was not produced at $APP_DIR"
  verify_app_signature

  local version
  version="$($PLIST_BUDDY_BIN -c 'Print :CFBundleShortVersionString' "$APP_DIR/Contents/Info.plist")"
  [[ -n "$version" ]] || fail "app bundle has no release version"

  RELEASE_TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/pr-visualizer-release.XXXXXX")"
  trap 'rm -rf "$RELEASE_TEMPORARY_DIRECTORY"' EXIT

  local app_archive
  app_archive="$RELEASE_TEMPORARY_DIRECTORY/$APP_NAME.app.zip"

  step "Submit app for notarization"
  "$DITTO_BIN" -c -k --keepParent "$APP_DIR" "$app_archive"
  "$XCRUN_BIN" notarytool submit "$app_archive" --keychain-profile "$NOTARY_PROFILE" --wait --timeout 1h

  step "Staple and validate app"
  "$XCRUN_BIN" stapler staple "$APP_DIR"
  "$XCRUN_BIN" stapler validate "$APP_DIR"
  "$SPCTL_BIN" --assess --type execute --verbose=4 "$APP_DIR"

  local staging_directory
  staging_directory="$RELEASE_TEMPORARY_DIRECTORY/dmg-staging"
  mkdir -p "$staging_directory"
  "$DITTO_BIN" "$APP_DIR" "$staging_directory/$APP_NAME.app"
  ln -s /Applications "$staging_directory/Applications"

  local dmg_path
  local binary_architecture
  binary_architecture="$($LIPO_BIN -archs "$APP_DIR/Contents/MacOS/pr-visualizer")"

  local artifact_architecture
  case "$binary_architecture" in
    arm64)
      artifact_architecture="aarch64"
      ;;
    x86_64)
      artifact_architecture="x64"
      ;;
    *)
      fail "unsupported release binary architecture: $binary_architecture"
      ;;
  esac

  dmg_path="$DMG_DIR/${PRODUCT_PREFIX}_${version}_${artifact_architecture}.dmg"
  mkdir -p "$DMG_DIR"

  step "Create Developer ID signed DMG"
  "$HDIUTIL_BIN" create -volname "$APP_NAME" -srcfolder "$staging_directory" -fs HFS+ -format UDZO -ov "$dmg_path"
  "$CODESIGN_BIN" --force --sign "$DEV_ID" --timestamp "$dmg_path"
  "$CODESIGN_BIN" --verify --strict --verbose=2 "$dmg_path"

  step "Submit DMG for notarization"
  "$XCRUN_BIN" notarytool submit "$dmg_path" --keychain-profile "$NOTARY_PROFILE" --wait --timeout 1h

  step "Staple and validate DMG"
  "$XCRUN_BIN" stapler staple "$dmg_path"
  "$XCRUN_BIN" stapler validate "$dmg_path"
  "$SPCTL_BIN" --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"

  step "Publish verified release"
  "$ROOT/scripts/copy-dmg-to-icloud.sh" "$dmg_path"
  echo "Release ready: $dmg_path"
}

main "$@"
