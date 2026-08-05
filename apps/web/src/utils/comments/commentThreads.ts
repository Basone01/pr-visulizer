import type { ReviewComment } from "@pr-visulizer/shared"

// Group flat GitHub review comments into anchored THREADS — the pure core of the "show existing
// comments" feature (docs/architecture.md §11). No React, no fetching: comments in, threads out,
// so every rule below is testable in isolation.

export type CommentThread = {
  // The root comment's id — stable thread key for React and for expand/collapse state.
  rootId: number
  path: string
  side: "LEFT" | "RIGHT"
  // The head line this thread would anchor to inline, or null when it cannot: an OUTDATED root
  // (line === null), a LEFT/base-side root, or a file-level comment. `splitThreadsForView` sends
  // the null ones — and any whose line is off-screen — to the file bucket.
  anchorLine: number | null
  // Root first, then replies in chronological order.
  comments: ReviewComment[]
}

// A thread anchors inline only from the RIGHT/head side with a concrete line. LEFT-side and
// outdated (null-line) roots are deliberately NOT anchored — the base gutter carries no
// annotations today, and an outdated line no longer exists in the diff — so both go to the bucket.
//
// On a MULTI-LINE comment GitHub's `line` is the range's LAST line and `start_line` its first, so
// anchoring on `line` put the bubble at the bottom of the commented block — under the closing
// brace of the function someone commented on. The reviewer reads a range from its start, so that
// is where the marker belongs. Same `startLine ?? line` convention drafts already key by
// (utils/review/progress.ts), so both kinds of comment now anchor the same way.
//
// The `line === null` guard stays FIRST: a comment with no end line is outdated or file-level,
// and no start line can make it anchorable.
function anchorLineOf(root: ReviewComment): number | null {
  if (root.side !== "RIGHT") return null
  if (root.line === null) return null

  return root.startLine ?? root.line
}

// Order comments oldest-first, breaking ties by id so the result is deterministic regardless of
// input order (two comments can share a timestamp in a fixture).
function byCreatedAt(a: ReviewComment, b: ReviewComment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1

  return a.id - b.id
}

// Build one thread per ROOT (a comment with no in_reply_to_id), attaching every reply to it.
// A reply whose parent is absent from the input is treated as its own root rather than dropped —
// losing a comment silently is worse than showing an orphan thread.
export function buildThreads(comments: ReviewComment[]): CommentThread[] {
  const byId = new Map<number, ReviewComment>()
  for (const comment of comments) byId.set(comment.id, comment)

  // The root each comment ultimately belongs to (follow the in_reply_to_id chain to its end).
  function rootIdOf(comment: ReviewComment): number {
    let current = comment
    const seen = new Set<number>([current.id])

    while (current.inReplyToId !== null) {
      const parent = byId.get(current.inReplyToId)
      // Parent missing, or a cycle — stop and treat the current comment as the chain's root.
      if (!parent || seen.has(parent.id)) break

      current = parent
      seen.add(current.id)
    }

    return current.id
  }

  const commentsByRoot = new Map<number, ReviewComment[]>()
  for (const comment of comments) {
    const rootId = rootIdOf(comment)
    const existing = commentsByRoot.get(rootId)
    if (existing) existing.push(comment)
    else commentsByRoot.set(rootId, [comment])
  }

  const threads: CommentThread[] = []
  for (const [rootId, group] of commentsByRoot) {
    const ordered = [...group].sort(byCreatedAt)
    const root = byId.get(rootId) ?? ordered[0]!

    threads.push({
      rootId,
      path: root.path,
      side: root.side,
      anchorLine: anchorLineOf(root),
      comments: ordered,
    })
  }

  // Deterministic thread order: by anchor line (unanchored last), then by root id.
  return threads.sort((a, b) => {
    const lineA = a.anchorLine ?? Number.MAX_SAFE_INTEGER
    const lineB = b.anchorLine ?? Number.MAX_SAFE_INTEGER
    if (lineA !== lineB) return lineA - lineB

    return a.rootId - b.rootId
  })
}

export type ThreadsForView = {
  // Threads anchored to a currently-VISIBLE head line, keyed by that line.
  byHeadLine: Map<number, CommentThread[]>
  // Everything that can't show inline right now: outdated, LEFT-side, file-level, or a head line
  // outside the rendered set (a commit range or the hunks-only view can hide a commented line).
  bucket: CommentThread[]
}

// Split threads for ONE file against the head lines actually rendered. Purely derived from
// `visibleHeadLines`, so it self-corrects as the full-file / range / hunks view changes what is
// on screen — a thread whose line scrolls out of the view moves to the bucket, never crashes.
export function splitThreadsForView(
  threads: CommentThread[],
  visibleHeadLines: Set<number>
): ThreadsForView {
  const byHeadLine = new Map<number, CommentThread[]>()
  const bucket: CommentThread[] = []

  for (const thread of threads) {
    if (thread.anchorLine !== null && visibleHeadLines.has(thread.anchorLine)) {
      const existing = byHeadLine.get(thread.anchorLine)
      if (existing) existing.push(thread)
      else byHeadLine.set(thread.anchorLine, [thread])
      continue
    }

    bucket.push(thread)
  }

  return { byHeadLine, bucket }
}
