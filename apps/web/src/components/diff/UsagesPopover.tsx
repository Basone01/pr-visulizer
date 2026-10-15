import type { ReactNode } from "react"

import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

import styles from "./Diff.module.css"

// A definition's "N usages" popover (§10): each usage listed with its location. A click peeks the
// usage inline under its item (code + context lines), ⌘/Ctrl-click jumps straight there.
//
// Deep mode finds usages OUTSIDE the PR too (ghost files), so the list splits into "In this
// PR" and "Not in this PR" the moment an outside usage exists; an all-inside list stays flat
// (the labels would be noise on the common case). Outside targets open the ghost viewer.
//
// Thin on purpose: the nav machine owns which usage is peeked, the host builds the peek itself.
// This component only places `peekContent` under the matching item.
export function UsagesPopover({
  anchor,
  changedPaths,
  peekedUsage,
  peekContent,
  onPeek,
  onJumpTo,
}: {
  anchor: SymbolAnchor
  // Paths of the PR's changed files — membership decides which group a usage lands in.
  changedPaths: Set<string>
  peekedUsage: OccurrenceRef | null
  peekContent: ReactNode
  onPeek: (usage: OccurrenceRef) => void
  onJumpTo: (usage: OccurrenceRef) => void
}) {
  const inPr = anchor.usages.filter((usage) => changedPaths.has(usage.path))
  const outside = anchor.usages.filter((usage) => !changedPaths.has(usage.path))

  function usageItem(usage: OccurrenceRef, ghost: boolean) {
    const isPeeked =
      peekedUsage !== null && peekedUsage.path === usage.path && peekedUsage.line === usage.line
    const itemClass = [
      styles.usageItem,
      ghost ? styles.usageGhost : "",
      isPeeked ? styles.usageItemPeeked : "",
      "mono",
    ]
      .filter(Boolean)
      .join(" ")

    return (
      <div key={`${usage.path}:${usage.line}`}>
        <button
          type="button"
          className={itemClass}
          aria-expanded={isPeeked}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) onJumpTo(usage)
            else onPeek(usage)
          }}
        >
          {usage.path}:{usage.line}
        </button>
        {isPeeked && peekContent}
      </div>
    )
  }

  if (outside.length === 0) {
    return (
      <div className={styles.usages}>{anchor.usages.map((usage) => usageItem(usage, false))}</div>
    )
  }

  return (
    <div className={styles.usages}>
      {inPr.length > 0 && (
        <>
          <div className={styles.usageGroupLabel}>In this PR</div>
          {inPr.map((usage) => usageItem(usage, false))}
        </>
      )}
      <div className={styles.usageGroupLabel}>Not in this PR · unchanged</div>
      {outside.map((usage) => usageItem(usage, true))}
    </div>
  )
}
