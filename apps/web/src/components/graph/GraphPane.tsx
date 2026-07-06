import type { Edge as PrEdge } from "@pr-visulizer/shared"
import { Background, type Edge, MarkerType, type Node, ReactFlow } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useMemo } from "react"

import type { FileNodeVM, GhostNodeVM } from "@/entity/viewModels"

import { useElkLayout } from "@/hooks/useElkLayout"

import { FileNode, type FileNodeData } from "./FileNode"
import { GhostNode } from "./GhostNode"
import styles from "./GraphPane.module.css"

const nodeTypes = { file: FileNode, ghost: GhostNode }

type GraphPaneProps = {
  fileNodes: FileNodeVM[]
  ghostNodes: GhostNodeVM[]
  edges: PrEdge[]
  currentPath: string
  onSelect: (path: string) => void
}

// The dependency graph pane (docs/architecture.md §8, §2.1). React Flow renders the
// nodes; elkjs supplies a layered layout where each topo level is a row.
export function GraphPane({ fileNodes, ghostNodes, edges, currentPath, onSelect }: GraphPaneProps) {
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
      ...fileNodes.map((n) => ({ path: n.path })),
      ...ghostNodes.map((n) => ({ path: n.path })),
    ],
    [fileNodes, ghostNodes]
  )

  const positions = useElkLayout(layoutNodes, fileEdges)

  const rfNodes = useMemo<Node[]>(() => {
    if (!positions) return []

    const files: Node<FileNodeData>[] = fileNodes.map((node) => ({
      id: node.path,
      type: "file",
      position: positions.get(node.path) ?? { x: 0, y: 0 },
      data: { ...node, isCurrent: node.path === currentPath },
    }))

    const ghosts: Node<GhostNodeVM>[] = ghostNodes.map((node) => ({
      id: node.path,
      type: "ghost",
      position: positions.get(node.path) ?? { x: 0, y: 0 },
      data: node,
    }))

    return [...files, ...ghosts]
  }, [positions, fileNodes, ghostNodes, currentPath])

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges
        .filter((edge) => edge.level === "file")
        .map((edge) => ({
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          // Deep-confirmed edges (source lsp) draw in the accent color (edge-legend).
          style: { stroke: edge.source === "lsp" ? "var(--accent)" : "var(--muted)" },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edge.source === "lsp" ? "var(--accent)" : "var(--muted)",
          },
        })),
    [edges]
  )

  if (!positions) {
    return (
      <div className={styles.wrap}>
        <div className={styles.loading}>Laying out graph…</div>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="var(--border)" />
      </ReactFlow>
    </div>
  )
}
