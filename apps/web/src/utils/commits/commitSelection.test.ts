import type { PrCommit } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import {
  beginCommitSelection,
  commitSelectionRange,
  isCommitInSelection,
  selectCommit,
  selectedCommitRange,
} from "./commitSelection"

// The picker's two-click state machine (§10) — the same gesture as the diff gutter's line-range
// selection, so these mirror lineSelection's cases.

const PR_BASE_SHA = "base000000000000000000000000000000000000"

const commits: PrCommit[] = [
  {
    sha: "aaaa1110000000000000000000000000000000aa",
    parents: [PR_BASE_SHA],
    messageHeadline: "add rate-limit config",
    author: "contributor-dev",
    authoredAt: "2026-06-28T09:14:00Z",
  },
  {
    sha: "bbbb2220000000000000000000000000000000bb",
    parents: ["aaaa1110000000000000000000000000000000aa"],
    messageHeadline: "add the limiter",
    author: "contributor-dev",
    authoredAt: "2026-06-29T15:02:00Z",
  },
  {
    sha: "cccc3330000000000000000000000000000000cc",
    parents: ["bbbb2220000000000000000000000000000000bb"],
    messageHeadline: "wire the middleware",
    author: "contributor-dev",
    authoredAt: "2026-06-30T11:47:00Z",
  },
]

describe("selectCommit — the two-click machine", () => {
  it("anchors on the first click", () => {
    // Arrange
    const clickedIndex = 1

    // Act
    const selection = selectCommit(null, clickedIndex)

    // Assert
    const expected = { anchor: 1, focus: 1, phase: "anchored" }
    expect(selection).toEqual(expected)
  })

  it("completes a contiguous range on the second click", () => {
    // Arrange
    const firstClickIndex = 0
    const secondClickIndex = 2
    const anchored = selectCommit(null, firstClickIndex)

    // Act
    const ranged = selectCommit(anchored, secondClickIndex)

    // Assert
    const expected = { anchor: 0, focus: 2, phase: "ranged" }
    expect(ranged).toEqual(expected)
  })

  it("starts a FRESH selection on a click after the range is complete", () => {
    // Arrange
    const ranged = selectCommit(selectCommit(null, 0), 2)
    const thirdClickIndex = 1

    // Act
    const restarted = selectCommit(ranged, thirdClickIndex)

    // Assert — not a stretch of the old range; a new anchor.
    const expected = { anchor: 1, focus: 1, phase: "anchored" }
    expect(restarted).toEqual(expected)
  })

  it("completes a single-commit range when the same commit is clicked twice", () => {
    // Arrange
    const clickedIndex = 1
    const anchored = selectCommit(null, clickedIndex)

    // Act
    const ranged = selectCommit(anchored, clickedIndex)

    // Assert
    const expected = { startIndex: 1, endIndex: 1 }
    expect(commitSelectionRange(ranged)).toEqual(expected)
  })

  it("normalizes a range selected upward, from a later commit to an earlier one", () => {
    // Arrange
    const firstClickIndex = 2
    const secondClickIndex = 0

    // Act
    const ranged = selectCommit(selectCommit(null, firstClickIndex), secondClickIndex)

    // Assert
    const expected = { startIndex: 0, endIndex: 2 }
    expect(commitSelectionRange(ranged)).toEqual(expected)
  })

  it("marks every commit INSIDE the range as selected, not just the two ends", () => {
    // Arrange
    const ranged = selectCommit(selectCommit(null, 0), 2)

    // Act
    const membership = [0, 1, 2, 3].map((index) => isCommitInSelection(ranged, index))

    // Assert — index 1 is the middle of the range; index 3 is past its end.
    const expected = [true, true, true, false]
    expect(membership).toEqual(expected)
  })
})

describe("selectedCommitRange", () => {
  it("derives the base from the FIRST selected commit's parent, not from the PR base", () => {
    // Arrange — selecting only the middle commit must NOT compare from the PR base.
    const middleIndex = 1
    const selection = beginCommitSelection(middleIndex)

    // Act
    const range = selectedCommitRange(selection, commits, PR_BASE_SHA)

    // Assert
    const expected = { baseSha: commits[0]?.sha, headSha: commits[1]?.sha }
    expect(range).toEqual(expected)
  })

  it("spans a multi-commit range from the first commit's parent to the last commit", () => {
    // Arrange
    const selection = selectCommit(selectCommit(null, 0), 2)

    // Act
    const range = selectedCommitRange(selection, commits, PR_BASE_SHA)

    // Assert
    const expected = { baseSha: PR_BASE_SHA, headSha: commits[2]?.sha }
    expect(range).toEqual(expected)
  })

  it("returns null with no selection, so the pane stays on the whole PR", () => {
    // Arrange
    const noSelection = null

    // Act
    const range = selectedCommitRange(noSelection, commits, PR_BASE_SHA)

    // Assert
    const expected = null
    expect(range).toEqual(expected)
  })

  it("returns null when the selection points past the commit list", () => {
    // Arrange — a stale selection after the list shrank must not invent a boundary.
    const staleSelection = beginCommitSelection(99)

    // Act
    const range = selectedCommitRange(staleSelection, commits, PR_BASE_SHA)

    // Assert
    const expected = null
    expect(range).toEqual(expected)
  })
})
