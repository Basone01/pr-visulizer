import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"
import { memo } from "react"

import type { GhostNodeVM } from "@/entity/viewModels"

import styles from "./FileNode.module.css"
import { isNodeDimmed, useGraphFocus } from "./graphFocus"

export type GhostNodeData = GhostNodeVM
export type GhostNodeType = Node<GhostNodeData, "ghost">

// A changed symbol id is `${path}#${name}`; the graph chip shows the short name.
function shortName(symbolId: string): string {
  return symbolId.slice(symbolId.lastIndexOf("#") + 1)
}

// An unchanged file that references changed code — context, never in the review queue
// (docs/architecture.md §6). Deep engine only; empty on the fast engine. The chip line and
// the ref count make concrete WHICH changed symbols it touches (graph-node design).
export const GhostNode = memo(function GhostNode({ data }: NodeProps<GhostNodeType>) {
  const focus = useGraphFocus()
  const refCount = data.usedChangedSymbols.length

  const className = [styles.node, styles.ghost, isNodeDimmed(focus, data.path) ? styles.dimmed : ""]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={className}>
      <Handle type="target" position={Position.Right} className={styles.handle} />
      <Handle type="source" position={Position.Left} className={styles.handle} />
      <div className={styles.top}>
        <span className={`${styles.name} mono`} title={data.fileName}>
          {data.fileName}
        </span>
        {/* Kept outside the truncating name span so the ghost marker never gets ellipsized. */}
        <span className={styles.order}>👻</span>
      </div>

      {refCount > 0 && (
        <div className={`${styles.chips} mono`}>
          {data.usedChangedSymbols.map(shortName).join(" · ")}
        </div>
      )}

      <div className={`${styles.meta} mono`}>
        unchanged · {refCount} ref{refCount === 1 ? "" : "s"} · deep only
      </div>
    </div>
  )
})
