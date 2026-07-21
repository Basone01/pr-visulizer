import type { Edge as PrEdge } from "@pr-visulizer/shared"
import {
  Background,
  type Edge,
  MarkerType,
  type Node,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useEffect, useMemo } from "react"

import { NODE_HEIGHT, NODE_WIDTH, nodeSize } from "@/utils/graph/elkLayout"

import { type FileNodeVM, type GhostNodeVM, fileNodeVariant } from "@/entity/viewModels"

import { useElkLayout } from "@/hooks/useElkLayout"

import { DependencyEdge } from "./DependencyEdge"
import { FileNode, type FileNodeData } from "./FileNode"
import { GhostNode } from "./GhostNode"
import styles from "./GraphPane.module.css"
import { ReviewedProgressChip } from "./ReviewedProgressChip"
import { type GraphFocus, GraphFocusProvider, NO_FOCUS } from "./graphFocus"

const nodeTypes = { file: FileNode, ghost: GhostNode }
const edgeTypes = { dependency: DependencyEdge }

// Pans the graph to center the active file whenever it changes — so selecting a file from the
// tray, the "next" button, or a jump-to-definition never leaves its node offscreen. Keeps the
// current zoom (setCenter, not fitView) so it's a smooth pan, not a zoom-bomb onto one node.
// Must be a child of <ReactFlow> to read the flow's store via useReactFlow.
function FocusActiveNode({ path }: { path: string }) {
  const flow = useReactFlow()

  useEffect(() => {
    if (!path) return

    const node = flow.getNode(path)
    if (!node) return

    const width = node.measured?.width ?? node.width ?? NODE_WIDTH
    const height = node.measured?.height ?? node.height ?? NODE_HEIGHT
    flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom: flow.getZoom(),
      duration: 300,
    })
  }, [path, flow])

  return null
}

type GraphPaneProps = {
  fileNodes: FileNodeVM[]
  ghostNodes: GhostNodeVM[]
  edges: PrEdge[]
  currentPath: string
  onSelect: (path: string) => void
  // Reviewed-progress overlay. These change on every checkmark; they feed only the chip, never
  // the layout or the node/edge memos, so a toggle costs the graph nothing.
  reviewedCount: number
  totalCount: number
  firstUnreviewedPath: string | null
}

// The dependency graph pane (docs/architecture.md §8, §2.1). React Flow renders the
// nodes; elkjs supplies a layered layout where each topo level is a row.
export function GraphPane({
  fileNodes,
  ghostNodes,
  edges,
  currentPath,
  onSelect,
  reviewedCount,
  totalCount,
  firstUnreviewedPath,
}: GraphPaneProps) {
  // Only file-level edges shape the graph and the ranking (§5 step 6).
  const fileEdges = useMemo(
    () =>
      edges
        .filter((edge) => edge.level === "file")
        .map((edge) => ({ from: edge.from, to: edge.to })),
    [edges]
  )

  const layoutNodes = useMemo(
    () => [
      ...fileNodes.map((n) => ({ path: n.path, ...fileNodeVariant(n) })),
      ...ghostNodes.map((n) => ({ path: n.path, ghost: true })),
    ],
    [fileNodes, ghostNodes]
  )

  const positions = useElkLayout(layoutNodes, fileEdges)

  // Focus + context: the open file's node and its DIRECT neighbours (files it depends on or
  // that depend on it) stay in focus; everything else dims. null when nothing is open — no
  // dimming, the whole graph reads at full strength.
  const focus = useMemo<GraphFocus>(() => {
    if (!currentPath) return NO_FOCUS

    const focusSet = new Set<string>([currentPath])
    for (const edge of fileEdges) {
      if (edge.from === currentPath) focusSet.add(edge.to)
      else if (edge.to === currentPath) focusSet.add(edge.from)
    }

    return { currentPath, focusSet }
  }, [currentPath, fileEdges])

  // Nodes and edges are pure functions of the TOPOLOGY + the layout. Neither depends on which
  // file is open — that rides the focus context — so a click rebuilds nothing here and React
  // Flow never re-adopts its store. The sizes are the ones elk laid out against, so React Flow
  // positions edges correctly before its measure pass lands.
  const rfNodes = useMemo<Node[]>(() => {
    if (!positions) return []

    const files: Node<FileNodeData>[] = fileNodes.map((node) => ({
      id: node.path,
      type: "file",
      position: positions.get(node.path) ?? { x: 0, y: 0 },
      ...nodeSize(fileNodeVariant(node)),
      data: node,
    }))

    const ghosts: Node<GhostNodeVM>[] = ghostNodes.map((node) => ({
      id: node.path,
      type: "ghost",
      position: positions.get(node.path) ?? { x: 0, y: 0 },
      ...nodeSize({ ghost: true }),
      data: node,
    }))

    return [...files, ...ghosts]
  }, [positions, fileNodes, ghostNodes])

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges
        .filter((edge) => edge.level === "file")
        .map((edge) => {
          // Deep-confirmed edges (source lsp) draw in the accent color (edge-legend).
          const color = edge.source === "lsp" ? "var(--accent)" : "var(--muted)"

          return {
            id: `${edge.from}->${edge.to}`,
            type: "dependency",
            source: edge.from,
            target: edge.to,
            style: { stroke: color },
            markerEnd: { type: MarkerType.ArrowClosed, color },
          }
        }),
    [edges]
  )

  const progressChip = (
    <ReviewedProgressChip
      reviewedCount={reviewedCount}
      totalCount={totalCount}
      firstUnreviewedPath={firstUnreviewedPath}
      onOpen={onSelect}
    />
  )

  if (!positions) {
    return (
      <div className={styles.wrap}>
        {progressChip}
        <div className={styles.loading}>Laying out graph…</div>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      {progressChip}
      <GraphFocusProvider value={focus}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_event, node) => onSelect(node.id)}
          // Selection's single home is `currentPath` (it also drives the diff pane). React
          // Flow keeps no selection of its own, so a click costs it no store update.
          elementsSelectable={false}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <FocusActiveNode path={currentPath} />
          <Background gap={16} color="var(--border)" />
        </ReactFlow>
      </GraphFocusProvider>
    </div>
  )
}
