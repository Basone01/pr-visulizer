// Decode base64 -> UTF-8 text with no node `Buffer` (docs/tauri-architecture.md §3):
// the engine now runs in the webview too, where `Buffer` does not exist. `atob`,
// `Uint8Array` and `TextDecoder` are web-standard globals present in both the browser
// and Node 24, so the same gateway decodes file content on either platform.
export function decodeBase64Utf8(base64: string): string {
  // GitHub's `content` field wraps base64 at ~60 chars with newlines; `atob` rejects any
  // non-base64 character, so strip whitespace before decoding.
  const binary = atob(base64.replace(/\s/g, ""))

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  // `atob` yields one byte per char (latin1); TextDecoder reassembles multi-byte UTF-8.
  return new TextDecoder("utf-8").decode(bytes)
}
