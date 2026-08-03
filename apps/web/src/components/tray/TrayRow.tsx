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
  onToggle,
  onOpen,
}: {
  row: TrayRowVM
  active: boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const className = [
    styles.row,
    row.reviewed ? styles.done : "",
    row.isNext ? styles.next : "",
    active ? styles.active : "",
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

      <button className={`${styles.path} mono`} onClick={() => onOpen(row.path)} title={row.path}>
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
