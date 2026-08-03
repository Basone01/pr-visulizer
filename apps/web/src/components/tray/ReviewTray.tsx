import type { QueueMode } from "@pr-visulizer/shared"
import { useState } from "react"

import type { PrView } from "@/entity/viewModels"

import type { Verdict } from "@/hooks/useSubmitReview"

import styles from "./ReviewTray.module.css"
import { SubmitReviewDialog } from "./SubmitReviewDialog"
import { TrayRow } from "./TrayRow"

// The two queue orderings, with a short "why" for the title (§8.4).
// The `value` is the PERSISTED QueueMode (storage key "queueMode") — renaming it would
// silently reset every saved preference, so only the label is display copy. "Branch" read as
// a *git* branch, which on a stacked PR (base = another feature branch) is a near-certain
// misreading; "Chain" names the dependency chain the mode actually walks.
const QUEUE_MODES: Array<{ value: QueueMode; label: string; hint: string }> = [
  { value: "foundations", label: "Foundations", hint: "Most-depended-upon files first" },
  { value: "branch", label: "Chain", hint: "Walk each dependency chain start→end" },
]

const VERDICTS: Array<{ value: Verdict; label: string }> = [
  { value: "approve", label: "Approve" },
  { value: "comment", label: "Comment" },
  { value: "request_changes", label: "Request changes" },
]

// GitHub rejects approving your own PR (§11) — the Approve verdict is disabled with this
// reason when the viewer authored the PR (task 4). Comment / Request-changes stay enabled.
const OWN_PR_APPROVE_HINT = "GitHub doesn't allow approving your own PR"

type ReviewTrayProps = {
  view: PrView
  chosenVerdict: Verdict | null
  approveDisabled: boolean
  onToggleReviewed: (path: string) => void
  onOpenFile: (path: string) => void
  activePath: string
  queueMode: QueueMode
  onChooseQueueMode: (mode: QueueMode) => void
  onChooseVerdict: (verdict: Verdict) => void
  onSubmit: () => void
  // How many drafted inline comments the submit will actually carry — read from the review
  // progress, which is what useSubmitReview sends, not re-counted off the tray rows.
  commentCount: number
  // Submit is a real, non-undoable POST to GitHub, so the button reports the whole round trip
  // rather than firing silently: confirm → pending → submitted, or the failure inline.
  isSubmitting: boolean
  isSubmitted: boolean
  submitError: string | null
  onResetSubmit: () => void
  // Set when the app's checkmarks could not be mirrored into GitHub's "Viewed" state (§11).
  // The checkmarks are still the reviewer's own — this only says the mirror is behind.
  viewedSyncError: string | null
  // Paths the diff pane's selected commit range touches, or null when no range is selected (§10).
  // null means "no range" — every row is listed. A range FILTERS the list down to the files
  // those commits changed; it never re-ranks it. Order, readiness and the reviewed counts all
  // stay whole-PR, so the rows still line up with the graph and with GitHub's "Viewed" state.
  rangeTouchedPaths: Set<string> | null
  onHide: () => void
}

// The review tray (docs/architecture.md §8, §11): queue ordered by ranking, live
// readiness per pending row, progress header, verdict trio, and a Submit that
// unlocks at n/n — or via an explicit override.
export function ReviewTray({
  view,
  chosenVerdict,
  approveDisabled,
  onToggleReviewed,
  onOpenFile,
  activePath,
  queueMode,
  onChooseQueueMode,
  onChooseVerdict,
  onSubmit,
  commentCount,
  isSubmitting,
  isSubmitted,
  submitError,
  onResetSubmit,
  viewedSyncError,
  rangeTouchedPaths,
  onHide,
}: ReviewTrayProps) {
  const [overridden, setOverridden] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const canSubmit = (view.allReviewed || overridden) && chosenVerdict !== null

  // A submitted review is done: the button becomes a success state rather than an invitation
  // to post a second review over the first.
  const unreviewedCount = view.totalCount - view.reviewedCount

  function closeConfirm(): void {
    setConfirming(false)
    onResetSubmit()
  }

  // The mode toggle only makes sense once a real ranking exists (the provisional overview view
  // has no graph, so fileNodes is empty).
  const hasRanking = view.fileNodes.length > 0

  // A selected commit range narrows the queue to the files those commits touched — the reviewer
  // asked "what did these commits change?", and rows they didn't change are noise. Filtered, not
  // re-ranked: the surviving rows keep their whole-PR ranking order.
  const rangeActive = rangeTouchedPaths !== null
  const visibleRows = rangeActive
    ? view.trayRows.filter((row) => rangeTouchedPaths.has(row.path))
    : view.trayRows

  return (
    <div className={styles.tray}>
      <div className={styles.header}>
        <span>Review queue</span>
        <span className={`${styles.count} mono`}>
          {view.reviewedCount}/{view.totalCount}
        </span>
        <button
          type="button"
          className={styles.hideButton}
          aria-label="Hide review queue"
          title="Hide panel"
          onClick={onHide}
        >
          －
        </button>
      </div>

      {hasRanking && (
        <div className={styles.modeToggle} role="group" aria-label="Queue order">
          {QUEUE_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className={`${styles.modeButton} ${queueMode === mode.value ? styles.modeOn : ""}`}
              aria-pressed={queueMode === mode.value}
              title={mode.hint}
              onClick={() => onChooseQueueMode(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
      )}

      {rangeActive && (
        <div className={styles.rangeFilter} role="status">
          <span className="mono">
            {visibleRows.length} of {view.trayRows.length}
          </span>{" "}
          files in the selected commits
        </div>
      )}

      <div className={styles.rows}>
        {rangeActive && visibleRows.length === 0 ? (
          <div className={styles.rangeEmpty}>No queued files in the selected commits.</div>
        ) : (
          visibleRows.map((row) => (
            <TrayRow
              key={row.path}
              row={row}
              active={row.path === activePath}
              onToggle={onToggleReviewed}
              onOpen={onOpenFile}
            />
          ))
        )}
      </div>

      <div className={styles.verdicts}>
        {VERDICTS.map((verdict) => {
          const isApproveBlocked = verdict.value === "approve" && approveDisabled

          return (
            <button
              key={verdict.value}
              className={`${styles.verdict} ${chosenVerdict === verdict.value ? styles.chosen : ""}`}
              disabled={isApproveBlocked}
              title={isApproveBlocked ? OWN_PR_APPROVE_HINT : undefined}
              onClick={() => onChooseVerdict(verdict.value)}
            >
              {verdict.label}
            </button>
          )
        })}
      </div>

      {!view.allReviewed && !overridden && (
        <div className={styles.override}>
          {view.totalCount - view.reviewedCount} file(s) left ·{" "}
          <button className={styles.overrideLink} onClick={() => setOverridden(true)}>
            submit without reviewing all
          </button>
        </div>
      )}

      {viewedSyncError && (
        <div className={styles.syncWarning} role="status">
          <span className={styles.syncDot}>●</span> Checkmarks saved here, but not synced to GitHub
          — {viewedSyncError}
        </div>
      )}

      <div className={styles.footer}>
        {isSubmitted ? (
          <div className={styles.submitted} role="status">
            ✓ Review submitted to GitHub
          </div>
        ) : (
          <button
            className={`${styles.btn} ${styles.primary}`}
            disabled={!canSubmit || isSubmitting}
            onClick={() => setConfirming(true)}
          >
            {isSubmitting ? "Submitting…" : "Submit review"}
          </button>
        )}
      </div>

      {confirming && chosenVerdict && !isSubmitted && (
        <SubmitReviewDialog
          verdict={chosenVerdict}
          commentCount={commentCount}
          unreviewedCount={unreviewedCount}
          submitting={isSubmitting}
          error={submitError}
          onConfirm={onSubmit}
          onCancel={closeConfirm}
        />
      )}
    </div>
  )
}
