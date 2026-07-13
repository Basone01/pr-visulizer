// A tiny browser-safe replacement for the `posix` members of node's `path` (docs/
// tauri-architecture.md §3): the fast engine runs in the webview now, where `node:path`
// does not exist. Repo paths are always POSIX (forward slashes, GitHub serves them that
// way), so this is pure string logic — no platform state — and behaves identically to
// `node:path.posix` for the relative repo paths the engine resolves. Wrapping the builtin
// here (utils leaf, no domain coupling) keeps the swap to one file.

// Collapse ".", "..", and empty segments the way node's normalize does. Inputs are
// always relative repo paths; a "../" that escapes the root is preserved (as node does).
function normalize(path: string): string {
  const segments = path.split("/")
  const resolved: string[] = []

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue

    if (segment === "..") {
      const top = resolved[resolved.length - 1]
      if (resolved.length > 0 && top !== "..") resolved.pop()
      else resolved.push("..")
      continue
    }

    resolved.push(segment)
  }

  return resolved.length > 0 ? resolved.join("/") : "."
}

// Join segments with "/" and normalize — matches `posix.join` for relative repo paths.
export function join(...segments: string[]): string {
  const joined = segments.filter((segment) => segment.length > 0).join("/")

  return joined.length > 0 ? normalize(joined) : "."
}

// The directory portion of a path — matches `posix.dirname` for the paths the engine sees.
export function dirname(path: string): string {
  const lastSlash = path.lastIndexOf("/")
  if (lastSlash < 0) return "."
  if (lastSlash === 0) return "/"

  return path.slice(0, lastSlash)
}

// The final path segment — matches `posix.basename` for the paths the engine sees.
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

// The extension including the leading dot, or "" — matches `posix.extname`. A leading dot
// (dotfile like ".gitignore") is NOT an extension, exactly as node treats it.
export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const lastDot = base.lastIndexOf(".")
  if (lastDot <= 0) return ""

  return base.slice(lastDot)
}
