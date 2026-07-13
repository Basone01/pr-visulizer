import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { addDraft, deleteDraft, draftKey, updateDraftBody } from "./progress"

// Draft comments round-trip through ReviewProgress (task 5): add appends, updateDraftBody
// edits in place by key, deleteDraft removes — all pure, producing a whole new progress each
// time (PUT /progress is full-state replacement, §9).

function emptyProgress(): ReviewProgress {
  return {
    userId: "reviewer-dev",
    owner: "acme",
    repo: "web",
    prNumber: 42,
    headSha: "head0042deadbeef",
    reviewedFiles: [],
    drafts: [],
  }
}

describe("draft add / edit / delete roundtrip", () => {
  it("adds, edits the body by key, then deletes a range draft", () => {
    // Arrange
    const rangeDraft: DraftComment = {
      path: "src/lib/rateLimiter.ts",
      startLine: 3,
      line: 6,
      side: "RIGHT",
      body: "extract this block",
    }
    const key = draftKey(rangeDraft)
    const editedBody = "extract this into a helper"

    // Act
    const afterAdd = addDraft(emptyProgress(), rangeDraft)
    const afterEdit = updateDraftBody(afterAdd, key, editedBody)
    const afterDelete = deleteDraft(afterEdit, key)

    // Assert
    const expectedAdded: DraftComment[] = [rangeDraft]
    const expectedEdited: DraftComment[] = [{ ...rangeDraft, body: editedBody }]
    expect(afterAdd.drafts).toEqual(expectedAdded)
    expect(afterEdit.drafts).toEqual(expectedEdited)
    expect(afterDelete.drafts).toEqual([])
  })

  it("replaces a draft on the same range instead of duplicating it", () => {
    // Arrange
    const firstDraft: DraftComment = {
      path: "src/api/routes/login.ts",
      line: 5,
      side: "RIGHT",
      body: "first note",
    }
    const sameRangeDraft: DraftComment = { ...firstDraft, body: "second note" }

    // Act
    const afterFirst = addDraft(emptyProgress(), firstDraft)
    const afterSecond = addDraft(afterFirst, sameRangeDraft)

    // Assert
    const expected: DraftComment[] = [sameRangeDraft]
    expect(afterSecond.drafts).toEqual(expected)
  })
})
