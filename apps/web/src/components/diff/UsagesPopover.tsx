import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

import styles from "./Diff.module.css"

// A definition's "N usages in this PR" popover (§10): each usage listed with its
// location — usages are single lines, so the list is effectively pre-peeked. Click
// one to jump.
export function UsagesPopover({
  anchor,
  onJumpTo,
}: {
  anchor: SymbolAnchor
  onJumpTo: (target: OccurrenceRef) => void
}) {
  return (
    <div className={styles.usages}>
      {anchor.usages.map((usage) => (
        <button
          key={`${usage.path}:${usage.line}`}
          className={`${styles.usageItem} mono`}
          onClick={() => onJumpTo(usage)}
        >
          {usage.path}:{usage.line}
        </button>
      ))}
    </div>
  )
}
