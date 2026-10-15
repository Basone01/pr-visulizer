import { type ReactElement, useEffect, useRef, useState } from "react"

import { renderMermaidSvg } from "@/utils/markdown/mermaidRenderer"

import styles from "./MermaidDiagram.module.css"

type MermaidDiagramProps = {
  source: string
}

type DiagramState =
  | { status: "loading" }
  | { status: "ready"; svg: SVGSVGElement }
  | { status: "error"; message: string | undefined }

const DIAGRAM_LABEL = "Mermaid diagram"

// mermaid hands back markup as a string. Parse it off-document so we only ever attach the one
// <svg> element (nothing else from the string), then label it for assistive tech.
function parseDiagramSvg(markup: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(markup, "text/html")
  const svg = parsed.querySelector("svg")
  if (!svg) throw new Error("mermaid returned no SVG")

  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", DIAGRAM_LABEL)
  return svg
}

// The ONE place in the markdown renderer that attaches markup we did not build as React elements
// (see MarkdownContent's header, guarantee 1). It is acceptable because mermaid runs with
// securityLevel "strict": label text is HTML-encoded and click bindings are disabled, so the SVG
// carries no live script or links. Anything that fails to render falls back to the source as code.
export function MermaidDiagram({ source }: MermaidDiagramProps): ReactElement {
  const [state, setState] = useState<DiagramState>({ status: "loading" })
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    setState({ status: "loading" })

    renderMermaidSvg(source)
      .then((markup) => {
        if (active) setState({ status: "ready", svg: parseDiagramSvg(markup) })
      })
      .catch((error: unknown) => {
        // mermaid's parse errors span several lines (with a caret diagram), keep the first one.
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]
        if (active) setState({ status: "error", message })
      })

    return () => {
      active = false
    }
  }, [source])

  useEffect(() => {
    if (state.status !== "ready") return

    containerRef.current?.replaceChildren(state.svg)
  }, [state])

  if (state.status === "error") {
    return (
      <>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
        <p className={styles.error}>Diagram could not be rendered: {state.message}</p>
      </>
    )
  }

  if (state.status === "loading") {
    return <p className={styles.placeholder}>Rendering diagram…</p>
  }

  return <div ref={containerRef} className={styles.diagram} />
}
