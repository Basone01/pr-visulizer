import { useEffect, useState } from "react"

import {
  type LayoutEdge,
  type LayoutNode,
  type NodePosition,
  layoutGraph,
} from "@/utils/graph/elkLayout"

// Runs the elk layered layout when the node/edge set changes. Layout is async, so it
// returns null until positions are ready; the graph pane shows nothing meanwhile.
export function useElkLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Map<string, NodePosition> | null {
  const [positions, setPositions] = useState<Map<string, NodePosition> | null>(null)

  // Re-layout only when the topology actually changes, not on every render.
  const signature = `${nodes.map((node) => node.path).join(",")}|${edges
    .map((edge) => `${edge.from}->${edge.to}`)
    .join(",")}`

  useEffect(() => {
    let active = true

    void layoutGraph(nodes, edges).then((next) => {
      if (active) setPositions(next)
    })

    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return positions
}
