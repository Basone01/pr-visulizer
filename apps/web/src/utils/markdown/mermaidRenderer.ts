// Narrow wrapper around mermaid (external-library rule): app code depends on this module, never
// on mermaid directly. mermaid is ~MBs of diagram code, so it is imported lazily on the first
// diagram and lands in its own chunks, never in the main bundle.

type MermaidTheme = "dark" | "default"

let renderCount = 0

// Same resolution order as tokens.css: an explicit data-theme on <html> wins, otherwise the OS
// preference decides.
function currentMermaidTheme(): MermaidTheme {
  const explicitTheme = document.documentElement.getAttribute("data-theme")
  if (explicitTheme === "dark") return "dark"
  if (explicitTheme === "light") return "default"

  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  return prefersDark ? "dark" : "default"
}

// Renders a mermaid definition to an SVG string. Rejects when the source is not valid mermaid,
// so the caller can fall back to showing the source as code.
export async function renderMermaidSvg(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid")

  // Re-initialised per render so a theme switch applies to the next diagram drawn.
  // `strict` HTML-encodes label text and disables click bindings in the diagram.
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: currentMermaidTheme() })

  renderCount += 1
  const { svg } = await mermaid.render(`mermaid-diagram-${renderCount}`, source)
  return svg
}
