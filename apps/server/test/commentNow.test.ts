import type { DraftComment } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// Immediate comment (§11): POST /comments publishes ONE inline comment right away through the
// gateway — no pending review involved — anchored to the PR's head commit.

const COMMENTS_URL = "/api/prs/acme/web/42/comments"

describe("POST /comments (PR #42)", () => {
  it("publishes a single-line comment through the gateway, anchored to head", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const comment: DraftComment = {
      path: "src/api/routes/login.ts",
      line: 5,
      side: "RIGHT",
      body: "publish me immediately",
    }

    // Act
    const response = await app.inject({ method: "POST", url: COMMENTS_URL, payload: comment })
    const added = gateway.addedComments

    // Assert
    const expected = {
      statusCode: 201,
      addedCount: 1,
      submittedReviews: 0,
      body: comment.body,
      commitId: "head0042deadbeef",
    }
    expect({
      statusCode: response.statusCode,
      addedCount: added.length,
      submittedReviews: gateway.submittedReviews.length,
      body: added[0]?.comment.body,
      commitId: added[0]?.commitId,
    }).toEqual(expected)
  })

  it("passes a multi-line range's startLine through to the gateway", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const rangeComment: DraftComment = {
      path: "src/api/routes/login.ts",
      line: 8,
      startLine: 4,
      side: "RIGHT",
      body: "this whole block",
    }

    // Act
    await app.inject({ method: "POST", url: COMMENTS_URL, payload: rangeComment })

    // Assert
    const expected = { line: 8, startLine: 4 }
    expect({
      line: gateway.addedComments[0]?.comment.line,
      startLine: gateway.addedComments[0]?.comment.startLine,
    }).toEqual(expected)
  })

  it("rejects a malformed comment body", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const missingLine = { path: "src/x.ts", side: "RIGHT", body: "no line" }

    // Act
    const response = await app.inject({ method: "POST", url: COMMENTS_URL, payload: missingLine })

    // Assert
    const expected = { statusCode: 400, addedCount: 0 }
    expect({ statusCode: response.statusCode, addedCount: gateway.addedComments.length }).toEqual(
      expected
    )
  })
})
