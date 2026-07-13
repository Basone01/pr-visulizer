// The CORS-free fetch for the Octokit gateway (docs/tauri-architecture.md §3 seam 2, §7).
// Tauri's HTTP plugin runs the request from Rust, so the webview's CORS rules never apply
// and the allowlist (api.github.com only) is enforced in capabilities/default.json. Octokit
// accepts an injected `fetch`, so the same gateway works in the webview with this one passed
// in. Lazy dynamic import keeps the plugin out of the web/http entry bundle.
export async function loadTauriFetch(): Promise<typeof globalThis.fetch> {
  const { fetch } = await import("@tauri-apps/plugin-http")
  return fetch as typeof globalThis.fetch
}
