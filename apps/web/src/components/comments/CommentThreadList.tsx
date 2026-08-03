import type { ReactNode } from "react"

import type { CommentThread } from "@/utils/comments/commentThreads"
import { formatRelativeTime } from "@/utils/time/relativeTime"

import { MarkdownContent } from "@/components/markdown/MarkdownContent"

import styles from "./CommentThreadList.module.css"

// Render existing GitHub review threads read-only (docs/architecture.md §11 — view-only pass).
// Each comment shows author + relative time and its body through MarkdownContent: the bodies are
// UNTRUSTED GitHub-flavored markdown, so they must go through the sanitizing wrapper, never raw.

type CommentThreadListProps = {
  threads: CommentThread[]
  // Optional per-thread caption (the bucket uses it to say WHY a thread isn't inline — outdated,
  // on the base side, off-screen). Inline threads pass nothing.
  captionFor?: (thread: CommentThread) => string | null
}

export function CommentThreadList({ threads, captionFor }: CommentThreadListProps): ReactNode {
  return (
    <div className={styles.threads}>
      {threads.map((thread) => {
        const caption = captionFor?.(thread) ?? null

        return (
          <div key={thread.rootId} className={styles.thread}>
            {caption && <div className={styles.caption}>{caption}</div>}

            {thread.comments.map((comment) => (
              <div key={comment.id} className={styles.comment}>
                <div className={styles.meta}>
                  <span className={styles.author}>{comment.author}</span>
                  <span className={styles.time}>{formatRelativeTime(comment.createdAt)}</span>
                </div>
                <div className={styles.body}>
                  <MarkdownContent source={comment.body} variant="inline" />
                </div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
