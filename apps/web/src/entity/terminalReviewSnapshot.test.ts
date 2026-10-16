import type { DraftComment } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { type ReviewSnapshotInput, buildReviewSnapshot } from "./terminalReviewSnapshot"

function snapshotInput(overrides: Partial<ReviewSnapshotInput> = {}): ReviewSnapshotInput {
  return {
    trayRows: [
      { path: "src/core.ts", status: "modified", reviewed: true },
      { path: "src/api.ts", status: "added", reviewed: false },
      { path: "src/old.ts", status: "deleted", reviewed: false },
    ],
    drafts: [],
    nextFilePath: null,
    queueMode: "foundations",
    openFilePath: "src/api.ts",
    selection: null,
    ...overrides,
  }
}

describe("buildReviewSnapshot", () => {
  it("keeps_the_trays_review_order", () => {
    // Arrange
    const queueMode = "branch"
    const input = snapshotInput({ queueMode })

    // Act
    const snapshot = buildReviewSnapshot(input)

    // Assert
    const expected = {
      queueMode,
      files: [
        { path: "src/core.ts", status: "modified", reviewed: true, suggestedNext: false },
        { path: "src/api.ts", status: "added", reviewed: false, suggestedNext: false },
        { path: "src/old.ts", status: "deleted", reviewed: false, suggestedNext: false },
      ],
    }
    expect(snapshot).toMatchObject(expected)
  })

  it("marks_the_suggested_next_file", () => {
    // Arrange
    const nextFilePath = "src/old.ts"
    const input = snapshotInput({ nextFilePath })

    // Act
    const snapshot = buildReviewSnapshot(input)

    // Assert
    const expected = [nextFilePath]
    expect(snapshot.files.filter((file) => file.suggestedNext).map((file) => file.path)).toEqual(
      expected
    )
  })

  it("maps_pending_drafts_to_head_line_ranges", () => {
    // Arrange
    const singleLineDraft: DraftComment = {
      path: "src/api.ts",
      line: 12,
      side: "RIGHT",
      body: "nit: rename",
    }
    const rangeDraft: DraftComment = {
      path: "src/api.ts",
      line: 24,
      startLine: 20,
      side: "RIGHT",
      body: "Split this block",
    }
    const input = snapshotInput({ drafts: [singleLineDraft, rangeDraft] })

    // Act
    const snapshot = buildReviewSnapshot(input)

    // Assert
    const expected = [
      { path: "src/api.ts", side: "RIGHT", startLine: 12, endLine: 12, body: "nit: rename" },
      { path: "src/api.ts", side: "RIGHT", startLine: 20, endLine: 24, body: "Split this block" },
    ]
    expect(snapshot.drafts).toEqual(expected)
  })

  it("keeps_left_side_drafts_with_their_base_lines", () => {
    // Arrange
    const baseSideDraft: DraftComment = {
      path: "src/old.ts",
      line: 3,
      side: "LEFT",
      body: "Why was this removed?",
    }
    const input = snapshotInput({ drafts: [baseSideDraft] })

    // Act
    const snapshot = buildReviewSnapshot(input)

    // Assert
    const expected = [
      { path: "src/old.ts", side: "LEFT", startLine: 3, endLine: 3, body: "Why was this removed?" },
    ]
    expect(snapshot.drafts).toEqual(expected)
  })

  it("carries_the_selection_only_for_the_open_file", () => {
    // Arrange
    const openFilePath = "src/api.ts"
    const openFileSelection = { path: openFilePath, startLine: 10, endLine: 14 }
    const staleSelection = { path: "src/core.ts", startLine: 1, endLine: 2 }

    // Act
    const openFileSnapshot = buildReviewSnapshot(
      snapshotInput({ openFilePath, selection: openFileSelection })
    )
    const staleSnapshot = buildReviewSnapshot(
      snapshotInput({ openFilePath, selection: staleSelection })
    )
    const noSelectionSnapshot = buildReviewSnapshot(
      snapshotInput({ openFilePath, selection: null })
    )

    // Assert
    expect(openFileSnapshot.selection).toEqual(openFileSelection)
    expect(staleSnapshot.selection).toBeNull()
    expect(noSelectionSnapshot.selection).toBeNull()
  })
})
