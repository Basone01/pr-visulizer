import { type PrSummary, prSummarySchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { buildTestApp } from "./helpers/buildTestApp.js"

// The home-screen picker's data path through the BFF (docs/tauri-architecture.md §5): the
// new route is gateway-backed, so browser mode gets the same open-PR list tauri mode reads
// straight from the gateway. Driven over the PR #42 fixture with the fake gateway.

const PULLS_URL = "/api/repos/acme/web/pulls"

describe("GET /api/repos/:owner/:repo/pulls (fake gateway)", () => {
  it("lists the repo's open PRs (PR #42 for acme/web)", async () => {
    // Arrange
    const { app } = buildTestApp()
    const expected: PrSummary[] = [
      {
        number: 42,
        title: "Add login rate limiting",
        author: "octocat",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
    ]

    // Act
    const response = await app.inject({ method: "GET", url: PULLS_URL })
    const summaries = z.array(prSummarySchema).parse(response.json())

    // Assert
    expect(summaries).toEqual(expected)
  })

  it("returns an empty list for a repo with no fixture PRs", async () => {
    // Arrange
    const { app } = buildTestApp()
    const emptyRepoUrl = "/api/repos/acme/mobile/pulls"

    // Act
    const response = await app.inject({ method: "GET", url: emptyRepoUrl })
    const summaries = z.array(prSummarySchema).parse(response.json())

    // Assert
    expect(summaries).toEqual([])
  })
})
