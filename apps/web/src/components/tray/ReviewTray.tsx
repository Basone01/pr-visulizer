import { useState } from "react"

import type { PrView } from "@/entity/viewModels"

import type { Verdict } from "@/hooks/useSubmitReview"

import styles from "./ReviewTray.module.css"
import { TrayRow } from "./TrayRow"

const VERDICTS: Array<{ value: Verdict; label: string }> = [
  { value: "approve", label: "Approve" },
  { value: "comment", label: "Comment" },
  { value: "request_changes", label: "Request changes" },
]

type ReviewTrayProps = {
  view: PrView
  chosenVerdict: Verdict | null
  onToggleReviewed: (path: string) => void
  onOpenFile: (path: string) => void
  onChooseVerdict: (verdict: Verdict) => void
  onSubmit: () => void
}

// The review tray (docs/architecture.md §8, §11): queue ordered by ranking, live
// readiness per pending row, progress header, verdict trio, and a Submit that
// unlocks at n/n — or via an explicit override.
export function ReviewTray({
  view,
  chosenVerdict,
  onToggleReviewed,
  onOpenFile,
  onChooseVerdict,
  onSubmit,
}: ReviewTrayProps) {
  const [overridden, setOverridden] = useState(false)

  const canSubmit = (view.allReviewed || overridden) && chosenVerdict !== null

  return (
    <div className={styles.tray}>
      <div className={styles.header}>
        <span>Review queue</span>
        <span className={`${styles.count} mono`}>
          {view.reviewedCount}/{view.totalCount}
        </span>
      </div>

      <div className={styles.rows}>
        {view.trayRows.map((row) => (
          <TrayRow key={row.path} row={row} onToggle={onToggleReviewed} onOpen={onOpenFile} />
        ))}
      </div>

      <div className={styles.verdicts}>
        {VERDICTS.map((verdict) => (
          <button
            key={verdict.value}
            className={`${styles.verdict} ${chosenVerdict === verdict.value ? styles.chosen : ""}`}
            onClick={() => onChooseVerdict(verdict.value)}
          >
            {verdict.label}
          </button>
        ))}
      </div>

      {!view.allReviewed && !overridden && (
        <div className={styles.override}>
          {view.totalCount - view.reviewedCount} file(s) left ·{" "}
          <button className={styles.overrideLink} onClick={() => setOverridden(true)}>
            submit without reviewing all
          </button>
        </div>
      )}

      <div className={styles.footer}>
        <button className={styles.btn} disabled={!canSubmit} onClick={onSubmit}>
          Submit review
        </button>
        <button
          className={`${styles.btn} ${styles.primary}`}
          disabled={!view.suggestedPath}
          onClick={() => view.suggestedPath && onOpenFile(view.suggestedPath)}
        >
          Open next
        </button>
      </div>
    </div>
  )
}
