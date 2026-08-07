import { type ReactNode, useState } from "react"

import type { CommentThread } from "@/utils/comments/commentThreads"
import { formatRelativeTime } from "@/utils/time/relativeTime"

import { MarkdownContent } from "@/components/markdown/MarkdownContent"

import { CommentEditor } from "./CommentEditor"
import styles from "./CommentThreadList.module.css"

// Render existing GitHub review threads (docs/architecture.md §11). Each comment shows author +
// relative time and its body through MarkdownContent: the bodies are UNTRUSTED GitHub-flavored
// markdown, so they must go through the sanitizing wrapper, never raw.
//
// The viewer's OWN comments additionally get an Edit affordance. Everyone else's stay exactly
// as they were — read-only — because GitHub would refuse the PATCH anyway, and an Edit button
// that always fails is worse than no button.

type CommentThreadListProps = {
  threads: CommentThread[]
  // Optional per-thread caption (the bucket uses it to say WHY a thread isn't inline — outdated,
  // on the base side, off-screen). Inline threads pass nothing.
  captionFor?: (thread: CommentThread) => string | null
  // The signed-in reviewer's login. A comment is editable when it matches its author; null (the
  // viewer query hasn't answered, or there is no viewer) means NOTHING is editable — the safe
  // direction, since the alternative offers an edit that GitHub rejects.
  viewerLogin?: string | null
  // Save one edit. REJECTS on failure, which is what keeps the editor open with the reviewer's
  // text and the reason. Absent → the list stays purely read-only.
  onSaveEdit?: (commentId: number, body: string) => Promise<void>
}

export function CommentThreadList({
  threads,
  captionFor,
  viewerLogin = null,
  onSaveEdit,
}: CommentThreadListProps): ReactNode {
  // Which comment is open in the editor, and how its save is going. Local on purpose: it is
  // "what is on screen right now", not server state — the edit itself lives in the mutation.
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function openEditor(commentId: number): void {
    setEditingId(commentId)
    setSaveError(null)
  }

  function closeEditor(): void {
    setEditingId(null)
    setSaveError(null)
  }

  async function saveEdit(commentId: number, body: string): Promise<void> {
    if (!onSaveEdit) return

    setSaving(true)
    setSaveError(null)
    try {
      await onSaveEdit(commentId, body)
      closeEditor()
    } catch (error) {
      // GitHub said no (a 403 on someone else's comment, a deleted comment, a dropped
      // connection): the comment is unchanged, so keep the editor and the words that were typed.
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.threads}>
      {threads.map((thread) => {
        const caption = captionFor?.(thread) ?? null

        return (
          <div key={thread.rootId} className={styles.thread}>
            {caption && <div className={styles.caption}>{caption}</div>}

            {thread.comments.map((comment) => {
              const canEdit =
                Boolean(onSaveEdit) && viewerLogin !== null && comment.author === viewerLogin
              const isEditing = editingId === comment.id

              return (
                <div key={comment.id} className={styles.comment}>
                  <div className={styles.meta}>
                    <span className={styles.author}>{comment.author}</span>
                    <span className={styles.time}>{formatRelativeTime(comment.createdAt)}</span>
                    {canEdit && !isEditing && (
                      <button
                        type="button"
                        className={styles.editButton}
                        onClick={() => openEditor(comment.id)}
                      >
                        Edit
                      </button>
                    )}
                  </div>

                  {isEditing ? (
                    <CommentEditor
                      initialBody={comment.body}
                      saving={saving}
                      error={saveError}
                      onSave={(body) => void saveEdit(comment.id, body)}
                      onCancel={closeEditor}
                    />
                  ) : (
                    <div className={styles.body}>
                      <MarkdownContent source={comment.body} variant="inline" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
