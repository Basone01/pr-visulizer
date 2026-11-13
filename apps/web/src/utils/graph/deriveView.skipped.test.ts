import type { AnalysisResult, ChangedFile, FileOmission, SkippedFile } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { pr42Analysis } from "@/service/fixture/pr42"

import { derivePrView } from "./deriveView"

// A generated file stays in the review queue after every ranked file, with its reason and no
// rank, and does not count toward completion. A file whose diff is omitted stays in the review:
// ranked, counted, with a short note.

const SOURCE_MAP_PATH = "assets/build/css/summary_css.css.map"
const ROUTER_PATH = "src/server/router.ts"

const sourceMapFile: ChangedFile = {
  path: SOURCE_MAP_PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  language: null,
}
const routerFile: ChangedFile = {
  path: ROUTER_PATH,
  status: "modified",
  additions: 4000,
  deletions: 3900,
  language: "typescript",
}
const skipped: SkippedFile[] = [{ path: SOURCE_MAP_PATH, reason: "generated" }]
const omitted: FileOmission[] = [
  { path: ROUTER_PATH, part: "diff", reason: "too-large", limitBytes: 131072 },
]

// PR #42 as the engine returns it with one generated file (listed in `files` and `skipped`,
// absent from `ranking`) and one file whose diff is omitted (ranked like any other).
const analysis: AnalysisResult = {
  ...pr42Analysis,
  files: [...pr42Analysis.files, sourceMapFile, routerFile],
  ranking: [
    ...pr42Analysis.ranking,
    {
      path: ROUTER_PATH,
      topoLevel: 0,
      fanIn: 0,
      churn: 7900,
      order: pr42Analysis.ranking.length + 1,
    },
  ],
  skipped,
  omitted,
}

const rankedPaths = [...analysis.ranking]
  .sort((a, b) => a.order - b.order)
  .map((ranked) => ranked.path)

describe("derivePrView with generated and diff-omitted files", () => {
  it.each(["foundations", "branch"] as const)(
    "lists a generated file last with its reason and no rank, and keeps a diff-omitted file ranked with its note (%s order)",
    (queueMode) => {
      // Arrange
      const noneReviewed: string[] = []

      // Act
      const view = derivePrView(analysis, noneReviewed, [], queueMode)

      // Assert
      const rowFacts = (path: string) => {
        const row = view.trayRows.find((candidate) => candidate.path === path)
        return row && { order: row.order, skipReason: row.skipReason, diffOmitted: row.diffOmitted }
      }
      const expected = {
        lastPath: SOURCE_MAP_PATH,
        generated: { order: null, skipReason: "generated", diffOmitted: null },
        routerRanked: true,
        routerNote: "too-large",
      }
      expect({
        lastPath: view.trayRows.at(-1)?.path,
        generated: rowFacts(SOURCE_MAP_PATH),
        routerRanked: (rowFacts(ROUTER_PATH)?.order ?? null) !== null,
        routerNote: rowFacts(ROUTER_PATH)?.diffOmitted,
      }).toEqual(expected)
    }
  )

  it("never draws a generated file in the graph or suggests it, even when every ranked file is reviewed", () => {
    // Arrange
    const everyRankedFileReviewed = rankedPaths

    // Act
    const view = derivePrView(analysis, everyRankedFileReviewed)

    // Assert
    const expected = { nodePaths: [...rankedPaths].sort(), suggestedPath: null }
    expect({
      nodePaths: view.fileNodes.map((node) => node.path).sort(),
      suggestedPath: view.suggestedPath,
    }).toEqual(expected)
  })

  it("counts only reviewable files toward completion and says how many generated files are not counted", () => {
    // Arrange
    const everyRankedFileReviewed = rankedPaths

    // Act
    const view = derivePrView(analysis, everyRankedFileReviewed)

    // Assert
    const expected = {
      reviewedCount: rankedPaths.length,
      totalCount: rankedPaths.length,
      allReviewed: true,
      generatedCount: 1,
    }
    expect({
      reviewedCount: view.reviewedCount,
      totalCount: view.totalCount,
      allReviewed: view.allReviewed,
      generatedCount: view.generatedCount,
    }).toEqual(expected)
  })
})
