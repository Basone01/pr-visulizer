# macOS desktop releases

Run `pnpm desktop:build` for every macOS release.
The command must finish successfully before sharing its DMG.
Development remains available through `pnpm desktop:dev`.

## Credentials

The release script uses the installed Developer ID Application certificate and the existing `MemiosCamNotary` keychain profile.
Set `DEV_ID` or `NOTARY_PROFILE` to use a different configured identity or profile.
Credentials stay in the keychain, not in the repository.

## Required release checks

1. Build the app with the Developer ID Application signing identity.
2. Verify its signature and hardened runtime.
3. Submit the release to Apple's notarization service and require acceptance.
4. Staple the notarization ticket and verify the app and DMG with Gatekeeper.
5. Copy only the verified release to iCloud Drive `MacOSBuiltApps`.

Missing credentials, rejected notarization, or failed verification must stop the release.
Do not share an unsigned fallback or copy an intermediate DMG manually.
A completed local copy does not prove that iCloud has finished uploading it.

Use the DMG matching the destination Mac's processor architecture.
The `aarch64` release is for Apple silicon.

## References

Tauri supports Developer ID signing through `APPLE_SIGNING_IDENTITY`.
See [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/).

Apple requires Developer ID signing and hardened runtime for notarization.
Its workflow uses `notarytool` and `stapler`.
See [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) and [customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
