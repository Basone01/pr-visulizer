import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"
import { memo } from "react"

import type { FileNodeVM } from "@/entity/viewModels"

import styles from "./FileNode.module.css"
import { isNodeDimmed, useGraphFocus } from "./graphFocus"

// Node data is exactly the view-model. Whether this node is the open file — or dimmed as
// out-of-focus — is read from the focus context, NOT copied into the node object: rebuilding
// every node's data on each click was the big-PR click lag.
export type FileNodeData = FileNodeVM
export type FileNodeType = Node<FileNodeData, "file">

// CSS-module members are string | undefined under noUncheckedIndexedAccess; the
// className join filters falsy values out.
const STATUS_CLASS: Record<FileNodeVM["status"], string | undefined> = {
  added: styles.added,
  modified: styles.modified,
  deleted: styles.deleted,
  renamed: styles.modified,
}

function churnLabel(additions: number, deletions: number): string {
  return `+${additions} −${deletions}`
}

// One changed file (docs/architecture.md §8 / graph-node design): border = diff
// status, blue ring = suggested next, dimmed + ✓ = reviewed.
// memo is required: @xyflow/react memoizes its own NodeWrapper but not the custom node, so
// without this every store commit re-renders all nodes. `data` is a stable VM object, so the
// default shallow compare is exactly right; focus arrives through context, which re-renders
// consumers on its own.
export const FileNode = memo(function FileNode({ data }: NodeProps<FileNodeType>) {
  const focus = useGraphFocus()

  const className = [
    styles.node,
    STATUS_CLASS[data.status],
    data.isNext ? styles.next : "",
    data.reviewed ? styles.done : "",
    focus.currentPath === data.path ? styles.current : "",
    isNodeDimmed(focus, data.path) ? styles.dimmed : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={className}>
      {/* Edges enter from the top (dependencies above) and leave from the bottom. */}
      <Handle type="target" position={Position.Right} className={styles.handle} />
      <Handle type="source" position={Position.Left} className={styles.handle} />

      <div className={styles.top}>
        <span className={`${styles.name} mono`} title={data.fileName}>
          {data.fileName}
        </span>
        <span className={styles.order}>#{data.order}</span>
      </div>

      {data.symbols.length > 0 && (
        <div className={`${styles.chips} mono`}>{data.symbols.join(" · ")}</div>
      )}

      <div className={`${styles.meta} mono`}>{churnLabel(data.additions, data.deletions)}</div>

      {/* Deep-only risk badge — shown only when something unchanged actually depends on this
          file (blastRadius > 0); a deep result with no dependents stays clean (§6). */}
      {data.blastRadius !== null && data.blastRadius > 0 && (
        <div className={styles.blast}>blast radius {data.blastRadius} ⚠️</div>
      )}

      {data.reviewed && <span className={styles.tick}>✓</span>}
    </div>
  )
})
