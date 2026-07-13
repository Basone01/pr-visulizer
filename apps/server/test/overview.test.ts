import { prOverviewSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// The instant-open overview route (docs/architecture.md §9, task 3): GET the PR meta route and
// it now returns meta + the changed-file list (validated by the shared contract), with each
// file's unified-diff patch stripped — the diff renderer fetches that per file. This is the
// payload the SPA renders the shell from before analysis lands.

const OVERVIEW_URL = "/api/prs/acme/web/42"

describe("GET /api/prs/:owner/:repo/:number (overview)", () => {
  it("returns PR meta + the six changed files, contract-valid", async () => {
    // Arrange
    const { app } = buildTestApp()
    const expectedPaths = [
      "src/api/routes/login.ts",
      "src/config/limits.ts",
      "src/lib/rateLimiter.test.ts",
      "src/lib/rateLimiter.ts",
      "src/middleware/withRateLimit.ts",
      "src/types/http.ts",
    ]

    // Act
    const response = await app.inject({ method: "GET", url: OVERVIEW_URL })
    const overview = prOverviewSchema.parse(response.json())
    const actualPaths = overview.files.map((file) => file.path).sort()

    // Assert
    const expected = { statusCode: 200, number: 42, paths: expectedPaths }
    expect({
      statusCode: response.statusCode,
      number: overview.pr.number,
      paths: actualPaths,
    }).toEqual(expected)
  })

  it("strips the unified-diff patch from each overview file", async () => {
    // Arrange
    const { app } = buildTestApp()

    // Act
    const response = await app.inject({ method: "GET", url: OVERVIEW_URL })
    const body = response.json() as { files: Array<Record<string, unknown>> }
    const anyHasPatch = body.files.some((file) => "patch" in file)

    // Assert
    expect(anyHasPatch).toBe(false)
  })
})
