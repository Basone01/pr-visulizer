import { type OmissionReason, treatedAsGeneratedText } from "@pr-visulizer/shared"
import { memo } from "react"

import type { TrayRow as TrayRowVM } from "@/entity/viewModels"

import { ReadinessChip } from "./ReadinessChip"
import styles from "./ReviewTray.module.css"

// A generated file has no rank, so its status cell says why instead of a readiness value.
// A file whose diff is omitted keeps its rank and readiness, plus a short note.
const DIFF_OMITTED_LABELS: Record<OmissionReason, string> = {
  "too-large": "diff too large",
  unreadable: "diff unreadable",
}
const DIFF_OMITTED_TITLES: Record<OmissionReason, string> = {
  "too-large": "The diff is too large to show here. The file is still part of the review.",
  unreadable: "The diff could not be read. The file is still part of the review.",
}

// Short on the row, with the evidence in the title and in visually hidden text.
function generatedTitle(row: TrayRowVM): string {
  const treated = row.generatedEvidence
    ? treatedAsGeneratedText(row.generatedEvidence)
    : "Treated as generated"
  return `${treated}: not analysed, ranked or counted. Not a check that the file is safe.`
}

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

      {row.diffOmitted !== null && (
        <span className={styles.skipReason} title={DIFF_OMITTED_TITLES[row.diffOmitted]}>
          {DIFF_OMITTED_LABELS[row.diffOmitted]}
        </span>
      )}

      {/* Shown on viewed rows too: whether a file needs review does not change once it is viewed. */}
      {row.skipReason === "generated" ? (
        <span className={styles.skipReason} title={generatedTitle(row)}>
          <span aria-hidden="true">generated</span>
          {/* A plain span's aria-label is ignored by many screen readers: real text is read. */}
          <span className={styles.visuallyHidden}>{generatedTitle(row)}</span>
        </span>
      ) : (
        <ReadinessChip readiness={row.readiness} isNext={row.isNext} reviewed={row.reviewed} />
      )}
    </div>
  )
})
