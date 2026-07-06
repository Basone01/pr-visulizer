import { analysisResultSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp, pollAnalysisReady } from "./helpers/buildTestApp.js"

// Occurrences power def ↔ usage navigation (docs/architecture.md §10) and are a free
// by-product of step-7 call resolution (§5). `checkLimit` is defined in rateLimiter.ts
// and called from withRateLimit.ts, so both a definition and a usage must be recorded.

const ANALYSIS_URL = "/api/prs/acme/web/42/analysis?engine=fast"

describe("AnalysisResult.occurrences (PR #42)", () => {
  it("records checkLimit's definition and its usage", async () => {
    // Arrange
    const { app } = buildTestApp()
    const checkLimitId = "src/lib/rateLimiter.ts#checkLimit"

    // Act
    const result = analysisResultSchema.parse(await pollAnalysisReady(app, ANALYSIS_URL))
    const checkLimitOccurrences = result.occurrences.filter((o) => o.symbolId === checkLimitId)
    const definition = checkLimitOccurrences.find((o) => o.role === "definition")
    const usage = checkLimitOccurrences.find((o) => o.role === "usage")

    // Assert
    const expected = {
      definitionPath: "src/lib/rateLimiter.ts",
      usagePath: "src/middleware/withRateLimit.ts",
    }
    expect({ definitionPath: definition?.path, usagePath: usage?.path }).toEqual(expected)
  })

  it("extracts checkLimit as a changed function symbol", async () => {
    // Arrange
    const { app } = buildTestApp()
    const checkLimitId = "src/lib/rateLimiter.ts#checkLimit"

    // Act
    const result = analysisResultSchema.parse(await pollAnalysisReady(app, ANALYSIS_URL))
    const checkLimit = result.symbols.find((symbol) => symbol.id === checkLimitId)

    // Assert
    const expected = { kind: "function", changeKind: "added" }
    expect({ kind: checkLimit?.kind, changeKind: checkLimit?.changeKind }).toEqual(expected)
  })
})
