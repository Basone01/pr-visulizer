// The app's one way to put text on the clipboard. Call sites depend on this, not on the
// browser API, so it can move to a Tauri command in one place if the webview ever refuses.
export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}
