import type { AnalysisResult, ChangedFile, DraftComment } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { derivePrView } from "@/utils/graph/deriveView"

import { pr42Analysis } from "@/service/fixture/pr42"

import { type ReviewSnapshotInput, buildReviewSnapshot } from "./terminalReviewSnapshot"

function snapshotInput(overrides: Partial<ReviewSnapshotInput> = {}): ReviewSnapshotInput {
  return {
    trayRows: [
      {
        path: "src/core.ts",
        status: "modified",
        reviewed: true,
        skipReason: null,
        diffOmitted: null,
      },
      { path: "src/api.ts", status: "added", reviewed: false, skipReason: null, diffOmitted: null },
      {
        path: "src/old.ts",
        status: "deleted",
        reviewed: false,
        skipReason: null,
        diffOmitted: null,
      },
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
        {
          path: "src/core.ts",
          status: "modified",
          reviewed: true,
          suggestedNext: false,
          skipReason: null,
          diffOmitted: null,
        },
        {
          path: "src/api.ts",
          status: "added",
          reviewed: false,
          suggestedNext: false,
          skipReason: null,
          diffOmitted: null,
        },
        {
          path: "src/old.ts",
          status: "deleted",
          reviewed: false,
          suggestedNext: false,
          skipReason: null,
          diffOmitted: null,
        },
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

  it("once the analysis lands, names each generated and diff-omitted file with its fact, and null for the others", () => {
    // Arrange
    const generatedPath = "assets/build/css/summary_css.css.map"
    const routerPath = "src/server/router.ts"
    const extraFiles: ChangedFile[] = [
      { path: generatedPath, status: "modified", additions: 1, deletions: 1, language: null },
      {
        path: routerPath,
        status: "modified",
        additions: 4000,
        deletions: 3900,
        language: "typescript",
      },
    ]
    const analysis: AnalysisResult = {
      ...pr42Analysis,
      files: [...pr42Analysis.files, ...extraFiles],
      ranking: [
        ...pr42Analysis.ranking,
        {
          path: routerPath,
          topoLevel: 0,
          fanIn: 0,
          churn: 7900,
          order: pr42Analysis.ranking.length + 1,
        },
      ],
      skipped: [{ path: generatedPath, reason: "generated", evidence: "file-name" }],
      omitted: [{ path: routerPath, part: "diff", reason: "too-large", limitBytes: 131072 }],
    }
    const view = derivePrView(analysis, [])

    // Act
    const snapshot = buildReviewSnapshot(snapshotInput({ trayRows: view.trayRows }))

    // Assert
    const factsByPath = new Map(
      snapshot.files.map((file) => [file.path, [file.skipReason, file.diffOmitted]])
    )
    const expected = {
      generated: ["generated", null],
      router: [null, "too-large"],
      plain: [null, null],
    }
    expect({
      generated: factsByPath.get(generatedPath),
      router: factsByPath.get(routerPath),
      plain: factsByPath.get(pr42Analysis.files[0]!.path),
    }).toEqual(expected)
  })
})
