import { memo } from "react"

import type { TrayRow as TrayRowVM } from "@/entity/viewModels"

import { ReadinessChip } from "./ReadinessChip"
import styles from "./ReviewTray.module.css"

// One queue row (docs/architecture.md §8 / review-tray design). The checkbox toggles
// "reviewed" (optimistic); clicking the path opens that file in the diff pane.
// memo, because opening a file re-renders the tray: only the two rows whose `active` flips
// need to change, not all 400 of a big PR's.
export const TrayRow = memo(function TrayRow({
  row,
  active,
  outsideRange,
  onToggle,
  onOpen,
}: {
  row: TrayRowVM
  active: boolean
  // True when a commit range is selected in the diff pane and this file isn't in it (§10). It is
  // a MARKER, not a mode: the row stays clickable and "mark viewed" stays enabled, because viewed
  // state is whole-PR state on GitHub and the review queue is a whole-PR concept.
  outsideRange: boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const className = [
    styles.row,
    row.reviewed ? styles.done : "",
    row.isNext ? styles.next : "",
    active ? styles.active : "",
    outsideRange ? styles.outsideRange : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={className}>
      <input
        type="checkbox"
        className={styles.check}
        checked={row.reviewed}
        onChange={() => onToggle(row.path)}
        aria-label={`Mark ${row.path} reviewed`}
      />

      <button
        className={`${styles.path} mono`}
        onClick={() => onOpen(row.path)}
        title={outsideRange ? `${row.path} — not changed in the selected commits` : row.path}
      >
        {row.path}
      </button>

      <span className={`${styles.churn} mono`} title="lines changed (additions + deletions)">
        {row.churn}
      </span>

      {row.draftCount > 0 && (
        <span className={styles.draftBadge} title={`${row.draftCount} draft comment(s)`}>
          💬 {row.draftCount}
        </span>
      )}

      {/* Blast radius (deep only) shown only when unchanged files depend on this one (§6). */}
      {row.blastRadius !== null && row.blastRadius > 0 && (
        <span className={styles.blast}>⚠️ {row.blastRadius}</span>
      )}

      <ReadinessChip readiness={row.readiness} isNext={row.isNext} reviewed={row.reviewed} />
    </div>
  )
})
