import { PR42_COMMIT_SHAS, PR42_PATHS } from "@pr-visulizer/engine"
import { fileHistorySchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// File history over HTTP (§10): the commits that touched one path, served through the gateway
// and parsed against the shared contract on the way out.

const HISTORY_URL = "/api/prs/acme/web/42/history"

describe("GET /history/* (PR #42)", () => {
  it("serves_the_file_history_for_a_path", async () => {
    // Arrange
    const { app } = buildTestApp()
    const path = PR42_PATHS.rateLimiter

    // Act
    const response = await app.inject({ method: "GET", url: `${HISTORY_URL}/${path}` })
    const body = fileHistorySchema.parse(response.json())

    // Assert
    const expected = {
      statusCode: 200,
      path,
      shas: [PR42_COMMIT_SHAS.limiter],
      truncated: false,
    }
    expect({
      statusCode: response.statusCode,
      path: body.path,
      shas: body.commits.map((commit) => commit.sha),
      truncated: body.truncated,
    }).toEqual(expected)
  })
})
