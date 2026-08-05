import type { ReviewComment } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildThreads, splitThreadsForView } from "./commentThreads"

// The pure grouping core of the existing-comments feature. Every rule the diff UI relies on —
// reply chaining, outdated/LEFT bucketing, off-screen bucketing — is pinned here without React.

const RATE_LIMITER = "src/lib/rateLimiter.ts"
const HTTP = "src/types/http.ts"

function comment(overrides: Partial<ReviewComment> & { id: number }): ReviewComment {
  // A concrete typed ReviewComment with literal defaults; each test overrides only what it drives.
  // `line`/`inReplyToId` use `in` checks, not `??`, so an EXPLICIT null (an outdated or root
  // comment) is honored instead of being coalesced back to the default.
  return {
    id: overrides.id,
    path: overrides.path ?? RATE_LIMITER,
    line: "line" in overrides ? overrides.line! : 3,
    startLine: "startLine" in overrides ? overrides.startLine! : null,
    side: overrides.side ?? "RIGHT",
    inReplyToId: "inReplyToId" in overrides ? overrides.inReplyToId! : null,
    author: overrides.author ?? "someone",
    body: overrides.body ?? "a comment",
    createdAt: overrides.createdAt ?? "2026-07-20T09:00:00Z",
  }
}

describe("buildThreads", () => {
  it("chains a reply onto its root, oldest comment first", () => {
    // Arrange — a root and its reply, deliberately passed reply-first to prove ordering.
    const root = comment({ id: 1, author: "senior", createdAt: "2026-07-20T09:00:00Z" })
    const reply = comment({
      id: 2,
      inReplyToId: 1,
      author: "contributor",
      createdAt: "2026-07-20T10:00:00Z",
    })
    const comments = [reply, root]

    // Act
    const threads = buildThreads(comments)

    // Assert — one thread, root then reply, anchored to the head line.
    const expectedRootId = 1
    const expectedOrder = [1, 2]
    const expectedAnchor = 3
    expect(threads).toHaveLength(1)
    expect(threads[0]!.rootId).toBe(expectedRootId)
    expect(threads[0]!.comments.map((c) => c.id)).toEqual(expectedOrder)
    expect(threads[0]!.anchorLine).toBe(expectedAnchor)
  })

  it("keeps two threads on the same line separate", () => {
    // Arrange
    const first = comment({ id: 1, line: 3 })
    const second = comment({ id: 2, line: 3 })
    const comments = [first, second]

    // Act
    const threads = buildThreads(comments)

    // Assert
    const expectedCount = 2
    expect(threads).toHaveLength(expectedCount)
    expect(threads.every((thread) => thread.anchorLine === 3)).toBe(true)
  })

  it("leaves an outdated (null-line) root unanchored", () => {
    // Arrange — an outdated comment: GitHub returns a null line after its line is force-pushed away.
    const outdated = comment({ id: 9, line: null })
    const comments = [outdated]

    // Act
    const threads = buildThreads(comments)

    // Assert
    const expectedAnchor = null
    expect(threads[0]!.anchorLine).toBe(expectedAnchor)
  })

  it("leaves a LEFT-side root unanchored even with a concrete line", () => {
    // Arrange — a base-side comment: it has a line, but the base gutter is not annotated inline.
    const leftSide = comment({ id: 7, side: "LEFT", line: 4, path: HTTP })
    const comments = [leftSide]

    // Act
    const threads = buildThreads(comments)

    // Assert
    const expectedAnchor = null
    expect(threads[0]!.anchorLine).toBe(expectedAnchor)
  })

  it("anchors a multi-line comment at the START of its range, not its last line", () => {
    // Arrange — GitHub reports a range comment as start_line..line, so `line` alone would put the
    // marker under the closing brace of the block the reviewer commented on.
    const startLine = 6
    const endLine = 9
    const rangeComment = comment({ id: 11, startLine, line: endLine })
    const comments = [rangeComment]

    // Act
    const threads = buildThreads(comments)

    // Assert
    const expectedAnchor = startLine
    expect(threads[0]!.anchorLine).toBe(expectedAnchor)
  })

  it("anchors a single-line comment at its own line, which carries no start line", () => {
    // Arrange — the common case: GitHub sends start_line null.
    const singleLine = comment({ id: 12, startLine: null, line: 3 })
    const comments = [singleLine]

    // Act
    const threads = buildThreads(comments)

    // Assert
    const expectedAnchor = 3
    expect(threads[0]!.anchorLine).toBe(expectedAnchor)
  })

  it("leaves an outdated root unanchored even when it carries a start line", () => {
    // Arrange — no end line means the range no longer exists in the diff; a start line on its own
    // must not resurrect it onto a row that means something else now.
    const outdatedRange = comment({ id: 13, startLine: 6, line: null })
    const comments = [outdatedRange]

    // Act
    const threads = buildThreads(comments)

    // Assert
    const expectedAnchor = null
    expect(threads[0]!.anchorLine).toBe(expectedAnchor)
  })

  it("treats a reply whose parent is missing as its own root rather than dropping it", () => {
    // Arrange — id 2 replies to id 1, but id 1 was not in the fetched page.
    const orphanReply = comment({ id: 2, inReplyToId: 1 })
    const comments = [orphanReply]

    // Act
    const threads = buildThreads(comments)

    // Assert — the comment survives as a one-comment thread.
    const expectedRootId = 2
    expect(threads).toHaveLength(1)
    expect(threads[0]!.rootId).toBe(expectedRootId)
  })
})

describe("splitThreadsForView", () => {
  it("anchors a visible-line thread and buckets an outdated one", () => {
    // Arrange
    const inline = comment({ id: 1, line: 3, side: "RIGHT" })
    const outdated = comment({ id: 2, line: null, side: "RIGHT", path: RATE_LIMITER })
    const threads = buildThreads([inline, outdated])
    const visibleHeadLines = new Set<number>([1, 2, 3, 4])

    // Act
    const { byHeadLine, bucket } = splitThreadsForView(threads, visibleHeadLines)

    // Assert
    const expectedInlineLine = 3
    const expectedBucketRoots = [2]
    expect(byHeadLine.get(expectedInlineLine)?.map((t) => t.rootId)).toEqual([1])
    expect(bucket.map((t) => t.rootId)).toEqual(expectedBucketRoots)
  })

  it("buckets a thread whose head line is not currently rendered", () => {
    // Arrange — the thread is on line 42, but the current view (a commit range) only shows 1–4.
    const offscreen = comment({ id: 5, line: 42, side: "RIGHT" })
    const threads = buildThreads([offscreen])
    const visibleHeadLines = new Set<number>([1, 2, 3, 4])

    // Act
    const { byHeadLine, bucket } = splitThreadsForView(threads, visibleHeadLines)

    // Assert
    const expectedBucketRoots = [5]
    expect(byHeadLine.size).toBe(0)
    expect(bucket.map((t) => t.rootId)).toEqual(expectedBucketRoots)
  })
})
