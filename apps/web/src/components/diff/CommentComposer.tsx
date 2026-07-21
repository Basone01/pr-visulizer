import { useState } from "react"

import styles from "./Diff.module.css"

// The compact inline comment composer (task 5): anchored to the selected line range, a textarea
// plus Add / Cancel. Used both for a new draft (empty) and for editing an existing one
// (initialBody). It owns only the in-progress text — saving is the caller's concern.
type CommentComposerProps = {
  startLine: number
  endLine: number
  initialBody?: string
  onSave: (body: string) => void
  // Publish immediately (no pending review). Absent while editing an existing draft —
  // an edit stays a draft.
  onSaveNow?: ((body: string) => void) | undefined
  // In-flight / failure state of the immediate publish; the composer stays open on failure.
  savingNow?: boolean
  saveNowError?: string | null
  onCancel: () => void
}

function rangeLabel(startLine: number, endLine: number): string {
  if (startLine === endLine) return `Comment on line ${startLine}`

  return `Comment on lines ${startLine}–${endLine}`
}

export function CommentComposer({
  startLine,
  endLine,
  initialBody = "",
  onSave,
  onSaveNow,
  savingNow = false,
  saveNowError = null,
  onCancel,
}: CommentComposerProps) {
  const [body, setBody] = useState(initialBody)

  const canSave = body.trim().length > 0

  return (
    <div className={styles.composer}>
      <div className={styles.composerLabel}>{rangeLabel(startLine, endLine)}</div>
      <textarea
        className={styles.composerInput}
        aria-label="Comment body"
        autoFocus
        value={body}
        placeholder="Leave a comment…"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className={styles.composerActions}>
        <button type="button" className={styles.composerCancel} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.composerAdd}
          disabled={!canSave || savingNow}
          onClick={() => onSave(body.trim())}
        >
          Add
        </button>
        {onSaveNow && (
          <button
            type="button"
            className={styles.composerAdd}
            disabled={!canSave || savingNow}
            title="Publish this comment on GitHub immediately (not part of the pending review)"
            onClick={() => onSaveNow(body.trim())}
          >
            {savingNow ? "Publishing…" : "Comment now"}
          </button>
        )}
      </div>
      {saveNowError && (
        <div className={styles.composerError} role="alert">
          {saveNowError}
        </div>
      )}
    </div>
  )
}
