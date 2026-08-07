// @vitest-environment node
import type { DraftComment } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { createFixturePrClient } from "./fixturePrClient"

// Fixture mode has no GitHub, so it has to play GitHub's half of a submit: the drafted comments
// come back as published ones. Without that, the app's "refetch the comments on submit success"
// behavior would be unobservable in the browser — the refetch would return the same seeded list.

const PR42: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

describe("fixture submitReview", () => {
  it("publishes the submitted drafts, so the next comment read carries them", async () => {
    // Arrange
    const draft: DraftComment = {
      path: "src/lib/rateLimiter.ts",
      line: 14,
      side: "RIGHT",
      body: "Clamp `windowMs` to at least 1ms here.",
    }
    const verdict = "comment" as const
    const client = createFixturePrClient()
    const before = await client.listReviewComments(PR42)

    // Act
    await client.submitReview(PR42, { verdict, body: "", comments: [draft] })
    const after = await client.listReviewComments(PR42)

    // Assert — the seeded threads are untouched and the submitted comment joins them, anchored
    // on the same line and side the draft carried.
    const expectedCount = before.length + 1
    const published = after[after.length - 1]!
    expect(after.length).toBe(expectedCount)
    expect(published.path).toBe(draft.path)
    expect(published.line).toBe(draft.line)
    expect(published.side).toBe(draft.side)
    expect(published.body).toBe(draft.body)
  })
})

// Editing has to stick the same way: the fixture is the only "GitHub" in fixture mode, so an
// edit it forgets would make the feature untestable in the browser.
describe("fixture updateReviewComment", () => {
  it("rewrites a seeded comment's body for the next read", async () => {
    // Arrange
    const client = createFixturePrClient()
    const seeded = await client.listReviewComments(PR42)
    const target = seeded[0]!
    const editedBody = "Rewritten: clamp the window to at least 1ms."

    // Act
    await client.updateReviewComment(PR42, target.id, editedBody)
    const afterEdit = await client.listReviewComments(PR42)

    // Assert — same comment, same anchor, new body; nothing else in the list moved.
    const expectedCount = seeded.length
    const reread = afterEdit.find((comment) => comment.id === target.id)
    expect(afterEdit.length).toBe(expectedCount)
    expect(reread?.body).toBe(editedBody)
    expect(reread?.line).toBe(target.line)
  })

  it("rewrites a comment this session submitted", async () => {
    // Arrange — a draft published by a submit is editable exactly like a seeded one.
    const draft: DraftComment = {
      path: "src/config/limits.ts",
      line: 3,
      side: "RIGHT",
      body: "first wording",
    }
    const verdict = "comment" as const
    const client = createFixturePrClient()
    await client.submitReview(PR42, { verdict, body: "", comments: [draft] })
    const published = (await client.listReviewComments(PR42)).at(-1)!
    const editedBody = "second wording"

    // Act
    await client.updateReviewComment(PR42, published.id, editedBody)
    const afterEdit = await client.listReviewComments(PR42)

    // Assert
    const expectedBody = editedBody
    expect(afterEdit.at(-1)?.body).toBe(expectedBody)
  })

  it("rejects an unknown comment id, like GitHub's 404", async () => {
    // Arrange
    const client = createFixturePrClient()
    const unknownCommentId = 999999

    // Act
    const outcome = await client
      .updateReviewComment(PR42, unknownCommentId, "into the void")
      .then(() => null)
      .catch((error: Error) => error)

    // Assert
    const expectedMessage = `No review comment ${unknownCommentId}`
    expect(outcome?.message).toBe(expectedMessage)
  })
})
