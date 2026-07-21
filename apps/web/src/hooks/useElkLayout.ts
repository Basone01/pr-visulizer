import { useEffect, useMemo, useState } from "react"

import type { LayoutEdge, LayoutNode, NodePosition } from "@/utils/graph/elkLayout"

import { runElkLayoutInWorker } from "@/workers/runElkLayoutInWorker"

// Runs the elk layered layout when the node/edge set changes. The layout itself is seconds of
// synchronous CPU on a big graph, so it runs in a worker; this hook returns null until the
// positions arrive and the graph pane shows a placeholder meanwhile.
export function useElkLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Map<string, NodePosition> | null {
  const [positions, setPositions] = useState<Map<string, NodePosition> | null>(null)

  // Re-layout only when the topology actually changes, not whenever the arrays are rebuilt
  // (checking a file off rebuilds the view models but moves no node).
  const signature = useMemo(
    () =>
      `${nodes
        .map(
          (node) =>
            // Height-affecting flags are part of the key: the reserved box changes with them, so a
            // change must re-run the layout (§2.1), not just when a node is added or removed.
            `${node.path}${node.ghost ? "+g" : ""}${node.hasSymbols ? "+s" : ""}${node.hasBlast ? "+b" : ""}`
        )
        .join(",")}|${edges.map((edge) => `${edge.from}->${edge.to}`).join(",")}`,
    [nodes, edges]
  )

  useEffect(() => {
    // No nodes, no worker to spawn — an empty layout is already the answer.
    if (nodes.length === 0) {
      setPositions(new Map())
      return
    }

    const abort = new AbortController()

    runElkLayoutInWorker(nodes, edges, { signal: abort.signal })
      .then(setPositions)
      .catch((error: unknown) => {
        // Our own cleanup aborting a superseded layout — not a failure to report.
        if (error instanceof DOMException && error.name === "AbortError") return

        console.error("graph layout failed", error)
      })

    return () => abort.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return positions
}
