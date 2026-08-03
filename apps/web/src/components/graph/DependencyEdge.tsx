import { BaseEdge, type Edge, type EdgeProps, getBezierPath } from "@xyflow/react"
import { memo, useMemo } from "react"

import styles from "./GraphPane.module.css"
import { isEdgeDimmed, useGraphFocus } from "./graphFocus"

// One dependency arrow. The edge OBJECT carries only what the topology decides (endpoints,
// colour); whether it is dimmed comes from the focus context, so selecting a file never
// rebuilds the edge array (docs/architecture.md §8).
export type DependencyEdgeType = Edge<Record<string, never>, "dependency">

export const DependencyEdge = memo(function DependencyEdge({
  source,
  target,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps<DependencyEdgeType>) {
  const focus = useGraphFocus()

  // Re-deriving the curve on every focus change is pure waste — it only moves when the layout
  // does, and a 1,600-edge graph re-focuses on every click.
  const [path] = useMemo(
    () => getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition }),
    [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition]
  )

  // markerEnd/style are always set by GraphPane; React Flow types them optional, and
  // exactOptionalPropertyTypes forbids forwarding a possible `undefined`.
  return (
    <BaseEdge
      path={path}
      className={isEdgeDimmed(focus, source, target) ? styles.dimmed : ""}
      {...(markerEnd ? { markerEnd } : {})}
      {...(style ? { style } : {})}
    />
  )
})
