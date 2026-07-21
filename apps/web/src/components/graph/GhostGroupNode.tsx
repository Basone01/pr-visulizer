import { type Node, type NodeProps } from "@xyflow/react"
import { memo } from "react"

import styles from "./GhostGroupNode.module.css"
import { useGraphFocus } from "./graphFocus"

export type GhostGroupData = { ghostCount: number }
export type GhostGroupType = Node<GhostGroupData, "ghostGroup">

// The node id of the band's backdrop. Not a file path, so nothing that looks a node up by path
// (FocusActiveNode, onSelect) can ever collide with it.
export const GHOST_GROUP_NODE_ID = "__ghost-group__"

// Scenery, not a file: the bounded region the ghost band lives in, drawn behind its nodes. It says
// out loud what the dashed nodes only imply — this region is context and no part of the review
// queue (docs/architecture.md §6). Never clickable; GraphPane skips it in onNodeClick.
export const GhostGroupNode = memo(function GhostGroupNode({ data }: NodeProps<GhostGroupType>) {
  const focus = useGraphFocus()

  // No ghost is ever a neighbour of the open file (ghosts carry no edges), so the band recedes
  // with its own nodes the moment a file is open.
  const className = [styles.group, focus.focusSet !== null ? styles.dimmed : ""]
    .filter(Boolean)
    .join(" ")

  const plural = data.ghostCount === 1 ? "file" : "files"

  return (
    <div className={className}>
      <div className={`${styles.label} mono`}>
        👻 context · not in review · {data.ghostCount} unchanged {plural}
      </div>
    </div>
  )
})
