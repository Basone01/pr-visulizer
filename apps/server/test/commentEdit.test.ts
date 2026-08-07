import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// Editing an own published comment (§11): PATCH /comments/:id forwards the new body to the
// gateway and the next list read serves it. Only the body travels — a published comment cannot
// be re-anchored, and an empty body would blank it, so neither is accepted.

const COMMENTS_URL = "/api/prs/acme/web/42/comments"
const SEEDED_COMMENT_ID = 5001

type ReviewCommentRow = { id: number; body: string; line: number | null }

describe("PATCH /comments/:commentId (PR #42)", () => {
  it("forwards the new body to the gateway and serves it on the next read", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const editedBody = "Rewritten: clamp the window to at least 1ms."

    // Act
    const response = await app.inject({
      method: "PATCH",
      url: `${COMMENTS_URL}/${SEEDED_COMMENT_ID}`,
      payload: { body: editedBody },
    })
    const listed = await app.inject({ method: "GET", url: COMMENTS_URL })
    const reread = (listed.json() as ReviewCommentRow[]).find(
      (comment) => comment.id === SEEDED_COMMENT_ID
    )

    // Assert — one forwarded edit, and the read side agrees with it.
    const expected = {
      statusCode: 200,
      forwarded: [{ commentId: SEEDED_COMMENT_ID, body: editedBody }],
      rereadBody: editedBody,
    }
    expect({
      statusCode: response.statusCode,
      forwarded: gateway.updatedComments.map((update) => ({
        commentId: update.commentId,
        body: update.body,
      })),
      rereadBody: reread?.body,
    }).toEqual(expected)
  })

  it("leaves the comment's anchor alone", async () => {
    // Arrange — the seeded comment sits on a line; an edit must not move it.
    const { app } = buildTestApp()
    const before = await app.inject({ method: "GET", url: COMMENTS_URL })
    const lineBefore = (before.json() as ReviewCommentRow[]).find(
      (comment) => comment.id === SEEDED_COMMENT_ID
    )?.line

    // Act
    await app.inject({
      method: "PATCH",
      url: `${COMMENTS_URL}/${SEEDED_COMMENT_ID}`,
      payload: { body: "same place, new words" },
    })
    const after = await app.inject({ method: "GET", url: COMMENTS_URL })

    // Assert
    const expectedLine = lineBefore
    const lineAfter = (after.json() as ReviewCommentRow[]).find(
      (comment) => comment.id === SEEDED_COMMENT_ID
    )?.line
    expect(lineAfter).toBe(expectedLine)
  })

  it("rejects an empty body instead of blanking the comment", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const blankBody = "   "

    // Act
    const response = await app.inject({
      method: "PATCH",
      url: `${COMMENTS_URL}/${SEEDED_COMMENT_ID}`,
      payload: { body: blankBody },
    })

    // Assert — nothing reached the gateway.
    const expected = { statusCode: 400, forwardedCount: 0 }
    expect({
      statusCode: response.statusCode,
      forwardedCount: gateway.updatedComments.length,
    }).toEqual(expected)
  })

  it("rejects a non-numeric comment id", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const notAnId = "abc"

    // Act
    const response = await app.inject({
      method: "PATCH",
      url: `${COMMENTS_URL}/${notAnId}`,
      payload: { body: "still no" },
    })

    // Assert
    const expected = { statusCode: 400, forwardedCount: 0 }
    expect({
      statusCode: response.statusCode,
      forwardedCount: gateway.updatedComments.length,
    }).toEqual(expected)
  })
})
