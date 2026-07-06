import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"

import type { FileNodeVM } from "@/entity/viewModels"

import styles from "./FileNode.module.css"

// Node data carries the whole view-model plus whether it is the file open in the diff.
export type FileNodeData = FileNodeVM & { isCurrent: boolean }
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
export function FileNode({ data }: NodeProps<FileNodeType>) {
  const className = [
    styles.node,
    STATUS_CLASS[data.status],
    data.isNext ? styles.next : "",
    data.reviewed ? styles.done : "",
    data.isCurrent ? styles.current : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={className}>
      {/* Edges enter from the top (dependencies above) and leave from the bottom. */}
      <Handle type="target" position={Position.Bottom} className={styles.handle} />
      <Handle type="source" position={Position.Top} className={styles.handle} />

      <div className={styles.top}>
        <span className={`${styles.name} mono`}>{data.fileName}</span>
        <span className={styles.order}>#{data.order}</span>
      </div>

      {data.symbols.length > 0 && (
        <div className={`${styles.chips} mono`}>{data.symbols.join(" · ")}</div>
      )}

      <div className={`${styles.meta} mono`}>{churnLabel(data.additions, data.deletions)}</div>

      {data.blastRadius !== null && (
        <div className={styles.blast}>blast radius {data.blastRadius} ⚠️</div>
      )}

      {data.reviewed && <span className={styles.tick}>✓</span>}
    </div>
  )
}
