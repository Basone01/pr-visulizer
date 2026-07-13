import { describe, expect, it } from "vitest"

import {
  type AnalysisResult,
  RANKING_PRESETS,
  analysisResultSchema,
  rankFiles,
} from "../src/index.js"
import { pr42ContractEdges, pr42Files, pr42Paths, pr42RankingInput } from "./fixtures/pr42.js"

// The contract is the source of truth — an AnalysisResult must survive a round-trip
// through its boundary schema (parse-don't-validate, §3 / §9).
describe("AnalysisResult contract (§3)", () => {
  it("parses a full PR #42 result through the boundary schema", () => {
    // Arrange
    const ranking = rankFiles(pr42RankingInput, RANKING_PRESETS["foundations-first"])
    const result: AnalysisResult = {
      engine: "fast",
      pr: {
        owner: "acme",
        repo: "api",
        number: 42,
        title: "Add login rate limiting",
        author: "octocat",
        baseSha: "base0000",
        headSha: "head1111",
      },
      files: pr42Files,
      symbols: [
        {
          id: `${pr42Paths.http}#ApiError`,
          path: pr42Paths.http,
          name: "ApiError",
          kind: "type",
          span: { startLine: 3, endLine: 5 },
          changeKind: "modified",
        },
      ],
      edges: pr42ContractEdges,
      ranking,
      ghosts: [],
      occurrences: [
        {
          symbolId: `${pr42Paths.http}#ApiError`,
          path: pr42Paths.withRateLimit,
          line: 12,
          role: "usage",
        },
      ],
    }
    const expectedStartFile = pr42Paths.limits

    // Act
    const parsed = analysisResultSchema.parse(result)

    // Assert
    expect(parsed.ranking[0]?.path).toBe(expectedStartFile)
    expect(parsed.engine).toBe("fast")
  })

  it("rejects a payload with an unknown engine", () => {
    // Arrange
    const invalid = { engine: "psychic" }

    // Act
    const outcome = analysisResultSchema.safeParse(invalid)

    // Assert
    expect(outcome.success).toBe(false)
  })
})
