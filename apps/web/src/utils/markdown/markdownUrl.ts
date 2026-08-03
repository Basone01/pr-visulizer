// The URL policy for rendered markdown — the security seam of the preview.
//
// A PR's markdown is UNTRUSTED content rendered inside a privileged webview, so every URL in it
// is filtered down to a tiny allowlist before it ever reaches the DOM. Anything rejected becomes
// an empty string, which the renderer's components read as "no URL" and degrade to plain text.
//
// This is deliberately STRICTER than react-markdown's own `defaultUrlTransform` (which also
// permits `irc:`, `ircs:` and `xmpp:`, and passes RELATIVE urls straight through). Relative urls
// are rejected here because the app serves no repo assets: `./CONTRIBUTING.md` resolves against
// the SPA's own origin, and a bare `#section` would collide with the app's hash routing.

const LINK_PROTOCOLS = ["https:", "http:", "mailto:"]

// Images are fetched by the webview itself — no click, no OS handoff — so only TLS is allowed.
const IMAGE_PROTOCOLS = ["https:"]

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    // Not absolute (relative path, bare `#anchor`, or malformed) — rejected by policy.
    return null
  }
}

// Empty string = rejected. Trimmed first, because `  javascript:alert(1)` is the same URL to a
// browser but not to a naive protocol check.
function allowUrl(url: string, allowed: string[]): string {
  const trimmed = url.trim()
  const protocol = protocolOf(trimmed)
  if (protocol === null || !allowed.includes(protocol)) return ""

  return trimmed
}

export function safeMarkdownLinkUrl(url: string): string {
  return allowUrl(url, LINK_PROTOCOLS)
}

export function safeMarkdownImageUrl(url: string): string {
  return allowUrl(url, IMAGE_PROTOCOLS)
}
