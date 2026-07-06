import type { DraftComment } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// Review submit (docs/architecture.md §11): the POST must forward the mapped verdict
// (event), body, comments and head commit to the gateway — asserted against the fake.

const REVIEW_URL = "/api/prs/acme/web/42/review"

describe("POST /review (PR #42)", () => {
  it("forwards the mapped verdict, body and comments to the gateway", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const comment: DraftComment = {
      path: "src/api/routes/login.ts",
      line: 5,
      side: "RIGHT",
      body: "guard the null return",
    }
    const verdict = "request_changes" as const
    const body = "Please address the inline note before merge."
    const reviewPayload = { verdict, body, comments: [comment] }

    // Act
    const response = await app.inject({ method: "POST", url: REVIEW_URL, payload: reviewPayload })
    const submitted = gateway.submittedReviews

    // Assert
    const expected = {
      statusCode: 201,
      reviewCount: 1,
      event: "REQUEST_CHANGES",
      body,
      commentBodies: [comment.body],
      commitId: "head0042deadbeef",
    }
    expect({
      statusCode: response.statusCode,
      reviewCount: submitted.length,
      event: submitted[0]?.event,
      body: submitted[0]?.body,
      commentBodies: submitted[0]?.comments.map((c) => c.body),
      commitId: submitted[0]?.commitId,
    }).toEqual(expected)
  })
})
