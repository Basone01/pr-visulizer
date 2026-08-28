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

import { NODE_HEIGHT, NODE_WIDTH, type NodePosition, nodeSize } from "@/utils/graph/elkLayout"
import { buildGhostEdges } from "@/utils/graph/ghostEdges"
import { layoutGhostGroup } from "@/utils/graph/ghostGroupLayout"
import { DEFAULT_GRAPH_ZOOM_POLICY } from "@/utils/graph/graphViewport"
import { rangeVisibleGraph } from "@/utils/graph/rangeFilter"

import { type FileNodeVM, type GhostNodeVM, fileNodeVariant } from "@/entity/viewModels"

import { useElkLayout } from "@/hooks/useElkLayout"

import { DependencyEdge } from "./DependencyEdge"
import { FileNode, type FileNodeData } from "./FileNode"
import { GHOST_GROUP_NODE_ID, type GhostGroupData, GhostGroupNode } from "./GhostGroupNode"
import { GhostNode } from "./GhostNode"
import styles from "./GraphPane.module.css"
import { ReviewedProgressChip } from "./ReviewedProgressChip"
import { type GraphFocus, GraphFocusProvider, focusAroundPath } from "./graphFocus"

const nodeTypes = { file: FileNode, ghost: GhostNode, ghostGroup: GhostGroupNode }
const edgeTypes = { dependency: DependencyEdge }

// Pans the graph to center the active file whenever it changes — so selecting a file from the
// tray, the "next" button, or a jump-to-definition never leaves its node offscreen. Keeps the
// current zoom (setCenter, not fitView) so it's a smooth pan, not a zoom-bomb onto one node.
// Must be a child of <ReactFlow> to read the flow's store via useReactFlow.
function FocusActiveNode({ path }: { path: string }) {
  const flow = useReactFlow()

  useEffect(() => {
    if (!path) return

    // Nothing here fights the initial fit: on mount this effect runs before React Flow has
    // adopted the nodes, so getNode misses and it bails (measured — suppressing this run changes
    // the mounted viewport by not one pixel). The fit owns the first frame, clicks own the rest.
    const node = flow.getNode(path)
    if (!node) return

    const width = node.measured?.width ?? node.width ?? NODE_WIDTH
    const height = node.measured?.height ?? node.height ?? NODE_HEIGHT

    // Raise-only: the initial fit of a big PR lands far too zoomed out to read a node, so
    // selecting a file pulls back in to a legible zoom. A reviewer already zoomed in past the
    // floor keeps exactly the zoom they chose.
    const zoom = Math.max(flow.getZoom(), DEFAULT_GRAPH_ZOOM_POLICY.focusMinZoom)

    flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom,
      duration: 300,
    })
  }, [path, flow])

  return null
}

// Frames the whole graph — ghost band included — each time a NEW layout arrives. Keyed on the
// positions object identity, which useElkLayout replaces only when the topology actually changes:
// checking a file off rebuilds the view models but keeps the same Map, so a checkmark never yanks
// the reviewer's own zoom back to the fit.
//
// The rAF matters: fitView reads React Flow's store, and this component is a CHILD of <ReactFlow>,
// so its effect runs BEFORE the parent has adopted the new nodes. Fitting synchronously would
// measure the previous graph.
function FitGraphOnLayout({ positions }: { positions: Map<string, NodePosition> }) {
  const flow = useReactFlow()

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void flow.fitView({ maxZoom: DEFAULT_GRAPH_ZOOM_POLICY.initialFitMax })
    })

    return () => cancelAnimationFrame(frame)
  }, [positions, flow])

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
  // Paths the diff pane's selected commit range touches, or null for the whole PR (§10) — the
  // SAME set the review tray filters on, so the two panes never disagree about what's in range.
  rangeTouchedPaths: Set<string> | null
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
  rangeTouchedPaths,
}: GraphPaneProps) {
  // What the selected commit range leaves on the canvas — file-level edges included. With no
  // range this is the whole PR, so nothing about the pane changes.
  const visible = useMemo(
    () => rangeVisibleGraph(fileNodes, edges, rangeTouchedPaths),
    [fileNodes, edges, rangeTouchedPaths]
  )

  const layoutEdges = useMemo(
    () => visible.fileEdges.map((edge) => ({ from: edge.from, to: edge.to })),
    [visible]
  )

  // Only CHANGED files go through the layered layout. A ghost's edges to the files it references
  // are render-only (see rfEdges) and deliberately never reach elk — fed in, the layered algorithm
  // pulls ghosts up into the file columns and the two groups become indistinguishable. They get
  // their own band below instead.
  //
  // Filtering feeds straight in: a narrower node set is a new layout signature, so elk re-lays
  // out the subset and FitGraphOnLayout re-frames it — no separate "refit on range" machinery.
  const layoutNodes = useMemo(
    () => visible.fileNodes.map((n) => ({ path: n.path, ...fileNodeVariant(n) })),
    [visible]
  )

  const positions = useElkLayout(layoutNodes, layoutEdges)

  // The ghost band, anchored under whatever elk produced. null when the PR has no ghosts (the
  // fast engine, the common case) — then nothing about the graph changes.
  const ghostGroup = useMemo(() => {
    if (!positions) return null

    const mainBoxes = visible.fileNodes.map((node) => ({
      ...(positions.get(node.path) ?? { x: 0, y: 0 }),
      ...nodeSize(fileNodeVariant(node)),
    }))

    return layoutGhostGroup(
      ghostNodes.map((node) => node.path),
      mainBoxes
    )
  }, [positions, visible, ghostNodes])

  // Focus + context: the open file's node and its DIRECT neighbours (files it depends on or
  // that depend on it) stay in focus; everything else dims. No dimming when nothing is open, or
  // when a range filtered the open file off the canvas.
  const focus = useMemo<GraphFocus>(
    () => focusAroundPath(currentPath, layoutEdges, visible.paths),
    [currentPath, layoutEdges, visible]
  )

  // Nodes and edges are pure functions of the TOPOLOGY + the layout. Neither depends on which
  // file is open — that rides the focus context — so a click rebuilds nothing here and React
  // Flow never re-adopts its store. The sizes are the ones elk laid out against, so React Flow
  // positions edges correctly before its measure pass lands.
  const rfNodes = useMemo<Node[]>(() => {
    if (!positions) return []

    const files: Node<FileNodeData>[] = visible.fileNodes.map((node) => ({
      id: node.path,
      type: "file",
      position: positions.get(node.path) ?? { x: 0, y: 0 },
      ...nodeSize(fileNodeVariant(node)),
      data: node,
    }))

    if (!ghostGroup) return files

    const ghosts: Node<GhostNodeVM>[] = ghostNodes.map((node) => ({
      id: node.path,
      type: "ghost",
      position: ghostGroup.positions.get(node.path) ?? { x: 0, y: 0 },
      ...nodeSize({ ghost: true }),
      data: node,
    }))

    // The backdrop goes first and sits behind everything (zIndex -1) so its own ghosts, and any
    // edge that ever crosses it, still draw on top.
    const groupBackdrop: Node<GhostGroupData> = {
      id: GHOST_GROUP_NODE_ID,
      type: "ghostGroup",
      position: { x: ghostGroup.box.x, y: ghostGroup.box.y },
      width: ghostGroup.box.width,
      height: ghostGroup.box.height,
      data: { ghostCount: ghostNodes.length },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    }

    return [groupBackdrop, ...files, ...ghosts]
  }, [positions, ghostGroup, visible, ghostNodes])

  const rfEdges = useMemo<Edge[]>(() => {
    const fileEdges: Edge[] = visible.fileEdges.map((edge) => {
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
    })

    // "a ghost node with a dashed edge" (§380). Dashed and muted — the same weight as the ghost
    // node's own dashed border, because a ghost is context, not review work. React Flow is the
    // only thing that ever sees these: elk laid the graph out without them, and the ranking never
    // knew about them.
    const ghostEdges: Edge[] = buildGhostEdges(ghostNodes, visible.paths).map((edge) => {
      const color = "var(--muted)"

      return {
        id: edge.id,
        type: "dependency",
        source: edge.from,
        target: edge.to,
        style: { stroke: color, strokeDasharray: "4 4" },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      }
    })

    return [...fileEdges, ...ghostEdges]
  }, [visible, ghostNodes])

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
          onNodeClick={(_event, node) => {
            // The band's backdrop is scenery, not a file — a click on it must open nothing.
            if (node.id === GHOST_GROUP_NODE_ID) return

            onSelect(node.id)
          }}
          // Selection's single home is `currentPath` (it also drives the diff pane). React
          // Flow keeps no selection of its own, so a click costs it no store update.
          elementsSelectable={false}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          // A big PR needs to zoom out far past React Flow's 0.5 default — that floor is what
          // clamped the initial frame and hid the ghost band (utils/graph/graphViewport).
          minZoom={DEFAULT_GRAPH_ZOOM_POLICY.min}
          maxZoom={DEFAULT_GRAPH_ZOOM_POLICY.max}
          fitView
          fitViewOptions={{ maxZoom: DEFAULT_GRAPH_ZOOM_POLICY.initialFitMax }}
          proOptions={{ hideAttribution: true }}
        >
          <FitGraphOnLayout positions={positions} />
          <FocusActiveNode path={currentPath} />
          <Background gap={16} color="var(--border)" />
        </ReactFlow>
      </GraphFocusProvider>
    </div>
  )
}
