#!/bin/sh
# Publishes one already-validated DMG to iCloud Drive (owner convention:
# MacOSBuiltApps). Release builds must not publish a file that lacks a stapled ticket.
set -e

DMG_PATH="${1:?usage: copy-dmg-to-icloud.sh <notarized-dmg>}"
DEST="${ICLOUD_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/MacOSBuiltApps}"
XCRUN_BIN="${XCRUN_BIN:-xcrun}"
DITTO_BIN="${DITTO_BIN:-ditto}"

[ -f "$DMG_PATH" ] || { echo "error: DMG not found: $DMG_PATH" >&2; exit 1; }
if [ -z "${ICLOUD_DIR:-}" ] && [ ! -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
  echo "error: iCloud Drive is unavailable" >&2
  exit 1
fi

mkdir -p "$DEST"
"$XCRUN_BIN" stapler validate "$DMG_PATH"
"$DITTO_BIN" "$DMG_PATH" "$DEST/$(basename "$DMG_PATH")"
"$XCRUN_BIN" stapler validate "$DEST/$(basename "$DMG_PATH")"

echo "DMG copied to iCloud Drive: $DEST"
exit 0
