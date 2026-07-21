import type { ElkNode } from "elkjs/lib/elk-api"

// Wrapper around elkjs (docs/architecture.md §2.1): a left-to-right layered layout where
// each topo level maps to a column. Edges are fed dependency -> dependent so foundations
// land in the LEFT-most column; the graph draws arrows the other way (pointing left, at
// the foundations they depend on).
//
// Pure on purpose: this module only SHAPES the graph elk is asked to lay out and reads the
// answer back. Running the layout is seconds of CPU, so it happens in elk's own web worker
// (workers/runElkLayoutInWorker.ts) — nothing here imports the elk engine.

export type LayoutEdge = { from: string; to: string } // from depends on to

export type NodePosition = { x: number; y: number }

// Reserved node box fed to elk (docs/architecture.md §2.1). elk lays out against THESE sizes, so
// a declared size must match what FileNode/GhostNode actually render — otherwise a taller node
// spills past its slot and its lower rows (the blast-radius badge) get covered by the node below.
// Heights are content-driven: FileNode is a title+churn base plus optional rows. Measured on the
// live app: base ~53px, the changed-symbol chips row adds ~18px, the blast-radius badge ~21px;
// the constants carry a few px of headroom so font/sub-pixel drift can never re-introduce overlap.
export const NODE_WIDTH = 168

const BASE_HEIGHT = 56 // title row + churn row — always present
const SYMBOLS_ROW = 20 // changed-symbol chips row (FileNode: symbols.length > 0)
const BLAST_ROW = 22 // blast-radius risk badge row (FileNode: blastRadius > 0)

// A ghost node reserves a fixed taller box: it always shows the "unchanged · N refs · deep only"
// line and never a blast badge (§6), so one constant covers its worst case.
export const GHOST_NODE_HEIGHT = 88

// Base file-node height with no optional rows — also the fallback callers use when a node has not
// been measured yet (GraphPane's FocusActiveNode).
export const NODE_HEIGHT = BASE_HEIGHT

// The content flags that change a node's rendered height. `ghost` wins (its own fixed box); for a
// file node the two row flags add their rows on top of the base.
export type NodeSizeVariant = {
  ghost?: boolean
  hasSymbols?: boolean
  hasBlast?: boolean
}

export type NodeSize = { width: number; height: number }

// Pure: the reserved box for one node as a function of the rows it renders. The single source of
// truth for both the elk layout (buildElkGraph) and the React Flow nodes (GraphPane), so the two
// can never disagree about how tall a node is — the controllable core the whole graph sizes from.
export function nodeSize(variant: NodeSizeVariant): NodeSize {
  if (variant.ghost) return { width: NODE_WIDTH, height: GHOST_NODE_HEIGHT }

  const height =
    BASE_HEIGHT + (variant.hasSymbols ? SYMBOLS_ROW : 0) + (variant.hasBlast ? BLAST_ROW : 0)

  return { width: NODE_WIDTH, height }
}

export type LayoutNode = { path: string } & NodeSizeVariant

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
      ...nodeSize(node),
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
