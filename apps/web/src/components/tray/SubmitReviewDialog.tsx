import type { Verdict } from "@/hooks/useSubmitReview"

import styles from "./SubmitReviewDialog.module.css"

// The confirm step in front of Submit review (§11). Submitting posts a REAL review to GitHub
// and is not undoable from here, so it gets a confirmation that states exactly what is about
// to be sent — the verdict, and how many drafted comments ride along. An in-app dialog, never
// window.confirm: a native modal freezes the Tauri webview and the desktop app stops
// responding to anything.

const VERDICT_COPY: Record<Verdict, { label: string; consequence: string }> = {
  approve: { label: "Approve", consequence: "This marks the PR approved on GitHub." },
  comment: { label: "Comment", consequence: "This posts a review without a verdict." },
  request_changes: {
    label: "Request changes",
    consequence: "This blocks the PR until you approve a later push.",
  },
}

function commentSummary(commentCount: number): string {
  if (commentCount === 0) return "no inline comments"
  if (commentCount === 1) return "1 inline comment"

  return `${commentCount} inline comments`
}

type SubmitReviewDialogProps = {
  verdict: Verdict
  commentCount: number
  // Files still unchecked when the reviewer chose to submit early — worth restating, since
  // this is the last moment to go back and read them.
  unreviewedCount: number
  submitting: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function SubmitReviewDialog({
  verdict,
  commentCount,
  unreviewedCount,
  submitting,
  error,
  onConfirm,
  onCancel,
}: SubmitReviewDialogProps) {
  const copy = VERDICT_COPY[verdict]

  return (
    <div className={styles.backdrop} onClick={submitting ? undefined : onCancel}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm review submission"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className={styles.title}>Submit this review?</h3>

        <div className={styles.summary}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Verdict</span>
            <span className={styles.summaryValue}>{copy.label}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Comments</span>
            <span className={styles.summaryValue}>{commentSummary(commentCount)}</span>
          </div>
        </div>

        <p className={styles.body}>{copy.consequence}</p>

        {unreviewedCount > 0 && (
          <p className={styles.warning}>{unreviewedCount} file(s) are still unchecked.</p>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : `Submit ${copy.label.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  )
}
