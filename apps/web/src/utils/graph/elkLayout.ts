import ELK from "elkjs/lib/elk.bundled.js"

// Wrapper around elkjs (docs/architecture.md §2.1): a layered layout where each topo
// level maps to a layout row. Edges are fed dependency -> dependent so foundations
// land at the top; the graph draws arrows the other way (pointing at foundations).

export type LayoutNode = { path: string }
export type LayoutEdge = { from: string; to: string } // from depends on to

export type NodePosition = { x: number; y: number }

export const NODE_WIDTH = 168
export const NODE_HEIGHT = 60

const elk = new ELK()

export async function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Promise<Map<string, NodePosition>> {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "26",
    },
    children: nodes.map((node) => ({ id: node.path, width: NODE_WIDTH, height: NODE_HEIGHT })),
    // Reverse direction: dependency (to) is the source so it sits in an earlier layer.
    edges: edges.map((edge, index) => ({
      id: `e${index}`,
      sources: [edge.to],
      targets: [edge.from],
    })),
  }

  const laid = await elk.layout(graph)

  const positions = new Map<string, NodePosition>()
  for (const child of laid.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }

  return positions
}
