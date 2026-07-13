#!/bin/sh
# Copies the built DMG(s) to iCloud Drive after every desktop build (owner convention:
# MacOSBuiltApps). Skips quietly on machines without iCloud Drive so the build never
# fails elsewhere. Runs again after notarization stapling, overwriting with the stapled file.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DMG_DIR="$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/dmg"
DEST="$HOME/Library/Mobile Documents/com~apple~CloudDocs/MacOSBuiltApps"

[ -d "$DMG_DIR" ] || exit 0
[ -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ] || exit 0

mkdir -p "$DEST"
copied=0
for dmg in "$DMG_DIR"/*.dmg; do
  [ -f "$dmg" ] || continue
  cp -f "$dmg" "$DEST/"
  copied=1
done

[ "$copied" = "1" ] && echo "DMG copied to iCloud Drive: $DEST"
exit 0
