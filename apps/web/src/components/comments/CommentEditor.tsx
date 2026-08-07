import { useState } from "react"

import styles from "./CommentThreadList.module.css"

// Inline editor for ONE published comment (docs/architecture.md §11). Same shape as the diff
// pane's draft composer — textarea, right-aligned Cancel/Save, inline failure line — but it is
// its own component: a published comment has no line range to label and no "comment now" path,
// and bending the composer's props to cover both would make the shared one harder to read.
//
// The body stays PLAIN markdown here, exactly as it is stored. Rendering comes back on its own
// once the save lands and the comment list is re-read.

type CommentEditorProps = {
  initialBody: string
  saving: boolean
  error: string | null
  onSave: (body: string) => void
  onCancel: () => void
}

export function CommentEditor({
  initialBody,
  saving,
  error,
  onSave,
  onCancel,
}: CommentEditorProps) {
  const [body, setBody] = useState(initialBody)

  // An empty body would blank the comment on GitHub — that is a delete, not an edit, so Save
  // stays closed for it. An unchanged body is allowed: it is a harmless no-op PATCH.
  const canSave = body.trim().length > 0

  return (
    <div>
      <textarea
        className={styles.editorInput}
        aria-label="Edit comment body"
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className={styles.editorActions}>
        <button type="button" className={styles.editorCancel} disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.editorSave}
          disabled={!canSave || saving}
          onClick={() => onSave(body.trim())}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && (
        <div className={styles.editorError} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
