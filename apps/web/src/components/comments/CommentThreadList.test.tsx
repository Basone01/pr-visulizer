import type { ReviewComment } from "@pr-visulizer/shared"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { CommentThread } from "@/utils/comments/commentThreads"

import { CommentThreadList } from "./CommentThreadList"

// Editing an own published comment (docs/architecture.md §11). Two rules decide the whole
// feature: the affordance appears ONLY on the viewer's own comments, and a failed save leaves
// both the comment and the reviewer's typed text alone.

const VIEWER_LOGIN = "reviewer-dev"

const OWN_COMMENT: ReviewComment = {
  id: 6001,
  path: "src/lib/rateLimiter.ts",
  line: 3,
  startLine: null,
  side: "RIGHT",
  inReplyToId: null,
  author: VIEWER_LOGIN,
  body: "Should this guard a **zero** window?",
  createdAt: "2026-07-20T09:12:00Z",
}

const SOMEONE_ELSES_REPLY: ReviewComment = {
  id: 6002,
  path: "src/lib/rateLimiter.ts",
  line: 3,
  startLine: null,
  side: "RIGHT",
  inReplyToId: 6001,
  author: "senior-dev",
  body: "Good catch, I'll clamp it.",
  createdAt: "2026-07-20T10:03:00Z",
}

// One thread carrying both authors, so a single render covers both directions of the gate.
function mixedThread(): CommentThread {
  return {
    rootId: OWN_COMMENT.id,
    path: OWN_COMMENT.path,
    side: "RIGHT",
    anchorLine: 3,
    comments: [OWN_COMMENT, SOMEONE_ELSES_REPLY],
  }
}

describe("CommentThreadList edit affordance", () => {
  it("offers Edit on the viewer's own comment and not on anyone else's", () => {
    // Arrange
    const onSaveEdit = vi.fn<(commentId: number, body: string) => Promise<void>>()

    // Act
    render(
      <CommentThreadList
        threads={[mixedThread()]}
        viewerLogin={VIEWER_LOGIN}
        onSaveEdit={onSaveEdit}
      />
    )

    // Assert — exactly one Edit button, sitting in the byline of the viewer's own comment
    // (each comment's meta row carries its author, so the row proves whose button it is).
    const expectedEditButtons = 1
    const editButtons = screen.getAllByRole("button", { name: "Edit" })
    const bylineWithEdit = editButtons[0]!.parentElement as HTMLElement
    expect(editButtons.length).toBe(expectedEditButtons)
    expect(within(bylineWithEdit).getByText(VIEWER_LOGIN)).toBeInTheDocument()
    expect(within(bylineWithEdit).queryByText(SOMEONE_ELSES_REPLY.author)).toBeNull()
  })

  it("stays read-only when the viewer is unknown", () => {
    // Arrange — the viewer query hasn't answered yet; offering an edit GitHub would reject is
    // worse than offering none.
    const viewerLogin = null

    // Act
    render(
      <CommentThreadList threads={[mixedThread()]} viewerLogin={viewerLogin} onSaveEdit={vi.fn()} />
    )

    // Assert
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull()
  })

  it("stays read-only when no save handler is wired", () => {
    // Arrange / Act — the ghost pane and any other read-only mount pass no handler.
    render(<CommentThreadList threads={[mixedThread()]} viewerLogin={VIEWER_LOGIN} />)

    // Assert
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull()
  })
})

describe("CommentThreadList editing", () => {
  it("forwards the comment id and the edited body, then closes the editor", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    const editedBody = "Should this clamp the window to at least 1ms?"
    render(
      <CommentThreadList
        threads={[mixedThread()]}
        viewerLogin={VIEWER_LOGIN}
        onSaveEdit={onSaveEdit}
      />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "Edit" }))
    const editor = screen.getByLabelText("Edit comment body")
    await user.clear(editor)
    await user.type(editor, editedBody)
    await user.click(screen.getByRole("button", { name: "Save" }))

    // Assert — one PATCH's worth of arguments, and the editor gives way to the rendered comment.
    const expectedCall = [OWN_COMMENT.id, editedBody]
    expect(onSaveEdit.mock.calls).toEqual([expectedCall])
    expect(screen.queryByLabelText("Edit comment body")).toBeNull()
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
  })

  it("opens with the current body and discards it on Cancel", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSaveEdit = vi.fn()
    render(
      <CommentThreadList
        threads={[mixedThread()]}
        viewerLogin={VIEWER_LOGIN}
        onSaveEdit={onSaveEdit}
      />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "Edit" }))
    const openedWith = (screen.getByLabelText("Edit comment body") as HTMLTextAreaElement).value
    await user.type(screen.getByLabelText("Edit comment body"), " and more")
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    // Assert — the editor started from the stored markdown and nothing was sent.
    const expectedInitialBody = OWN_COMMENT.body
    expect(openedWith).toBe(expectedInitialBody)
    expect(onSaveEdit).not.toHaveBeenCalled()
    expect(screen.queryByLabelText("Edit comment body")).toBeNull()
  })

  it("refuses to save an empty body", async () => {
    // Arrange — blanking a published comment is a delete wearing an edit's clothes.
    const user = userEvent.setup()
    render(
      <CommentThreadList
        threads={[mixedThread()]}
        viewerLogin={VIEWER_LOGIN}
        onSaveEdit={vi.fn()}
      />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "Edit" }))
    await user.clear(screen.getByLabelText("Edit comment body"))

    // Assert
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("keeps the editor and the typed text when the save fails", async () => {
    // Arrange — GitHub refused, so nothing changed there; losing the words would be the app's
    // own second failure.
    const user = userEvent.setup()
    const rejection = new Error("Resource not accessible by personal access token")
    const onSaveEdit = vi.fn().mockRejectedValue(rejection)
    const editedBody = "rewritten body"
    render(
      <CommentThreadList
        threads={[mixedThread()]}
        viewerLogin={VIEWER_LOGIN}
        onSaveEdit={onSaveEdit}
      />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "Edit" }))
    await user.clear(screen.getByLabelText("Edit comment body"))
    await user.type(screen.getByLabelText("Edit comment body"), editedBody)
    await user.click(screen.getByRole("button", { name: "Save" }))

    // Assert
    const expectedText = editedBody
    expect(await screen.findByRole("alert")).toHaveTextContent(rejection.message)
    expect((screen.getByLabelText("Edit comment body") as HTMLTextAreaElement).value).toBe(
      expectedText
    )
  })
})
