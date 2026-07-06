import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

import type { GhostNodeVM } from "@/entity/viewModels"

import styles from "./FileNode.module.css"

export type GhostNodeData = GhostNodeVM
export type GhostNodeType = Node<GhostNodeData, "ghost">

// An unchanged file that references changed code — context, never in the review queue
// (docs/architecture.md §6). Deep engine only; empty on the fast engine.
export function GhostNode({ data }: NodeProps<GhostNodeType>) {
  return (
    <div className={`${styles.node} ${styles.ghost}`}>
      <Handle type="target" position={Position.Bottom} className={styles.handle} />
      <Handle type="source" position={Position.Top} className={styles.handle} />
      <div className={styles.top}>
        <span className={`${styles.name} mono`}>{data.fileName} 👻</span>
      </div>
      <div className={`${styles.meta} mono`}>unchanged · deep only</div>
    </div>
  )
}
