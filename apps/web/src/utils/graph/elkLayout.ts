import type { ElkNode } from "elkjs/lib/elk-api"

// Wrapper around elkjs (docs/architecture.md §2.1): a left-to-right layered layout where
// each topo level maps to a column. Edges are fed dependency -> dependent so foundations
// land in the LEFT-most column; the graph draws arrows the other way (pointing left, at
// the foundations they depend on).
//
// Pure on purpose: this module only SHAPES the graph elk is asked to lay out and reads the
// answer back. Running the layout is seconds of CPU, so it happens in elk's own web worker
// (workers/runElkLayoutInWorker.ts) — nothing here imports the elk engine.

// `ghost` nodes render taller (extra "unchanged · N refs · deep only" line), so the
// layout must reserve their real height — telling elk the base height makes the row
// above overlap them (seen on real deep graphs).
export type LayoutNode = { path: string; ghost?: boolean }
export type LayoutEdge = { from: string; to: string } // from depends on to

export type NodePosition = { x: number; y: number }

export const NODE_WIDTH = 168
export const NODE_HEIGHT = 60
export const GHOST_NODE_HEIGHT = 88

export function buildElkGraph(nodes: LayoutNode[], edges: LayoutEdge[]): ElkNode {
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      // Roomy spacing: deep-mode graphs add ghost nodes, and tight packing made edges
      // and order badges collide on real PRs (owner feedback). Between-layers is now the
      // horizontal gap between columns; nodeNode the vertical gap within a column.
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "40",
      "elk.spacing.edgeNode": "28",
    },
    children: nodes.map((node) => ({
      id: node.path,
      width: NODE_WIDTH,
      height: node.ghost ? GHOST_NODE_HEIGHT : NODE_HEIGHT,
    })),
    // Reverse direction: dependency (to) is the source so it sits in an earlier layer.
    edges: edges.map((edge, index) => ({
      id: `e${index}`,
      sources: [edge.to],
      targets: [edge.from],
    })),
  }
}

export function readPositions(laidOut: ElkNode): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>()
  for (const child of laidOut.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }

  return positions
}
