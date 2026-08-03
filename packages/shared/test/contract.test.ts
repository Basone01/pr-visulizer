import { describe, expect, it } from "vitest"

import {
  type AnalysisResult,
  type PrMeta,
  RANKING_PRESETS,
  analysisResultSchema,
  prMetaSchema,
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

// The description viewer reads `body` + `htmlUrl` off PrMeta (GitHub `pulls.get`). Both must
// survive the boundary schema, and the nullable `body` must accept GitHub's "no description".
describe("PrMeta description fields (§3)", () => {
  it("parses a PrMeta carrying a markdown body and web url", () => {
    // Arrange
    const htmlUrl = "https://github.com/acme/web/pull/42"
    const body = "## Summary\n\n- rate limiting\n\n[docs](https://example.com)"
    const meta: PrMeta = {
      owner: "acme",
      repo: "web",
      number: 42,
      title: "Add login rate limiting",
      author: "contributor-dev",
      baseSha: "base0000",
      headSha: "head1111",
      body,
      htmlUrl,
    }

    // Act
    const parsed = prMetaSchema.parse(meta)

    // Assert
    expect(parsed.body).toBe(body)
    expect(parsed.htmlUrl).toBe(htmlUrl)
  })

  it("accepts a null body (GitHub returns null for a PR with no description)", () => {
    // Arrange
    const nullBody = null
    const meta = {
      owner: "acme",
      repo: "web",
      number: 7,
      title: "Docs tweak",
      author: "contributor-dev",
      baseSha: "base0000",
      headSha: "head2222",
      body: nullBody,
      htmlUrl: "https://github.com/acme/web/pull/7",
    }

    // Act
    const parsed = prMetaSchema.parse(meta)

    // Assert
    expect(parsed.body).toBeNull()
  })
})
