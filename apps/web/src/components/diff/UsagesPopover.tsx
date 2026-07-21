import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

import styles from "./Diff.module.css"

// A definition's "N usages" popover (§10): each usage listed with its location — usages are
// single lines, so the list is effectively pre-peeked. Click one to jump.
//
// Deep mode finds usages OUTSIDE the PR too (ghost files), so the list splits into "In this
// PR" and "Not in this PR" the moment an outside usage exists; an all-inside list stays flat
// (the labels would be noise on the common case). Outside targets open the ghost viewer.
export function UsagesPopover({
  anchor,
  changedPaths,
  onJumpTo,
}: {
  anchor: SymbolAnchor
  // Paths of the PR's changed files — membership decides which group a usage lands in.
  changedPaths: Set<string>
  onJumpTo: (target: OccurrenceRef) => void
}) {
  const inPr = anchor.usages.filter((usage) => changedPaths.has(usage.path))
  const outside = anchor.usages.filter((usage) => !changedPaths.has(usage.path))

  function usageButton(usage: OccurrenceRef, ghost: boolean) {
    return (
      <button
        key={`${usage.path}:${usage.line}`}
        className={`${styles.usageItem} ${ghost ? styles.usageGhost : ""} mono`}
        onClick={() => onJumpTo(usage)}
      >
        {usage.path}:{usage.line}
      </button>
    )
  }

  if (outside.length === 0) {
    return (
      <div className={styles.usages}>
        {anchor.usages.map((usage) => usageButton(usage, false))}
      </div>
    )
  }

  return (
    <div className={styles.usages}>
      {inPr.length > 0 && (
        <>
          <div className={styles.usageGroupLabel}>In this PR</div>
          {inPr.map((usage) => usageButton(usage, false))}
        </>
      )}
      <div className={styles.usageGroupLabel}>Not in this PR · unchanged</div>
      {outside.map((usage) => usageButton(usage, true))}
    </div>
  )
}
