import { analysisResultSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp, pollAnalysisReady } from "./helpers/buildTestApp.js"

// The load-bearing test (docs/architecture.md §8.1): booting the real BFF over the PR
// #42 fixture and running the fast engine end-to-end must reproduce the architecture
// doc's EXACT ranking — proving tree-sitter parsing of the fixture sources yields the
// §7 edge set, which the shared ranking core turns into these numbers.

const ANALYSIS_URL = "/api/prs/acme/web/42/analysis?engine=fast"

describe("GET /analysis (fast engine, PR #42)", () => {
  it("reproduces the §8.1 static order, topoLevel and fanIn exactly", async () => {
    // Arrange
    const { app } = buildTestApp()
    const expectedRanking = [
      { order: 1, path: "src/config/limits.ts", topoLevel: 0, fanIn: 3 },
      { order: 2, path: "src/types/http.ts", topoLevel: 0, fanIn: 1 },
      { order: 3, path: "src/lib/rateLimiter.ts", topoLevel: 1, fanIn: 2 },
      { order: 4, path: "src/middleware/withRateLimit.ts", topoLevel: 2, fanIn: 1 },
      { order: 5, path: "src/lib/rateLimiter.test.ts", topoLevel: 2, fanIn: 0 },
      { order: 6, path: "src/api/routes/login.ts", topoLevel: 3, fanIn: 0 },
    ]

    // Act
    const body = await pollAnalysisReady(app, ANALYSIS_URL)
    const result = analysisResultSchema.parse(body)
    const actualRanking = result.ranking.map((ranked) => ({
      order: ranked.order,
      path: ranked.path,
      topoLevel: ranked.topoLevel,
      fanIn: ranked.fanIn,
    }))

    // Assert
    expect(actualRanking).toEqual(expectedRanking)
  })

  it("returns 202 {status:'analyzing'} on the first request", async () => {
    // Arrange
    const { app } = buildTestApp()

    // Act
    const response = await app.inject({ method: "GET", url: ANALYSIS_URL })

    // Assert
    const expected = { statusCode: 202, body: { status: "analyzing" } }
    expect({ statusCode: response.statusCode, body: response.json() }).toEqual(expected)
  })

  it("tags the seven file edges source:'ast' from real tree-sitter parsing", async () => {
    // Arrange
    const { app } = buildTestApp()

    // Act
    const result = analysisResultSchema.parse(await pollAnalysisReady(app, ANALYSIS_URL))
    const fileEdges = result.edges.filter((edge) => edge.level === "file")
    const allAst = fileEdges.every((edge) => edge.source === "ast")

    // Assert
    const expected = { count: 7, allAst: true }
    expect({ count: fileEdges.length, allAst }).toEqual(expected)
  })
})
