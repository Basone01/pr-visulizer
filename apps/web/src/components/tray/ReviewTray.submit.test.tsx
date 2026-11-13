import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { PrView } from "@/entity/viewModels"

import { ReviewTray } from "./ReviewTray"
import { IDLE_SUBMIT_PROPS } from "./reviewTrayTestProps"

// Submitting posts a REAL, non-undoable review to GitHub (§11), so the button reports the
// whole round trip: a confirm dialog that states what is about to be sent, a pending state
// while it is in flight, and a success state afterwards. Failures stay on screen.
// The dialog is in-app on purpose — window.confirm freezes the Tauri webview.

function reviewedView(): PrView {
  return {
    trayRows: [],
    fileNodes: [],
    ghostNodes: [],
    suggestedPath: null,
    reviewedCount: 6,
    totalCount: 6,
    allReviewed: true,
    generatedCount: 0,
    factsByPath: null,
  }
}

// A partly-reviewed queue, for the "you still have files left" warning inside the dialog.
function partialView(): PrView {
  return { ...reviewedView(), reviewedCount: 4, allReviewed: false }
}

describe("ReviewTray submit confirmation", () => {
  it("asks for confirmation instead of submitting straight away", async () => {
    // Arrange
    const onSubmit = vi.fn()
    const chosenVerdict = "approve" as const
    const commentCount = 3
    render(
      <ReviewTray
        view={reviewedView()}
        chosenVerdict={chosenVerdict}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={onSubmit}
        {...IDLE_SUBMIT_PROPS}
        commentCount={commentCount}
      />
    )

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }))

    // Assert — the dialog names the verdict and the comment count; nothing was sent yet.
    // Scoped to the dialog: "Approve" is also the label of the verdict button behind it.
    const dialog = within(screen.getByRole("dialog", { name: "Confirm review submission" }))
    expect(dialog.getByText("Approve")).toBeInTheDocument()
    expect(dialog.getByText("3 inline comments")).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("submits only after the confirm button is pressed", async () => {
    // Arrange
    const onSubmit = vi.fn()
    const chosenVerdict = "request_changes" as const
    render(
      <ReviewTray
        view={reviewedView()}
        chosenVerdict={chosenVerdict}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={onSubmit}
        {...IDLE_SUBMIT_PROPS}
      />
    )

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }))
    await userEvent.click(screen.getByRole("button", { name: "Submit request changes" }))

    // Assert
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("warns inside the dialog when files are still unchecked", async () => {
    // Arrange — the last moment to go back and read them.
    const chosenVerdict = "approve" as const
    render(
      <ReviewTray
        view={partialView()}
        chosenVerdict={chosenVerdict}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={() => {}}
        {...IDLE_SUBMIT_PROPS}
      />
    )

    // Act
    await userEvent.click(screen.getByRole("button", { name: "submit without reviewing all" }))
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }))

    // Assert
    expect(screen.getByText("2 file(s) are still unchecked.")).toBeInTheDocument()
  })

  it("shows a pending state on the confirm button while the submit is in flight", () => {
    // Arrange
    const chosenVerdict = "approve" as const
    const isSubmitting = true

    // Act
    render(
      <ReviewTray
        view={reviewedView()}
        chosenVerdict={chosenVerdict}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={() => {}}
        {...IDLE_SUBMIT_PROPS}
        isSubmitting={isSubmitting}
      />
    )

    // Assert — the tray's own button reports in-flight and refuses a second press.
    const submitButton = screen.getByRole("button", { name: "Submitting…" })
    expect(submitButton).toBeDisabled()
  })

  it("replaces the button with a success state once the review is submitted", () => {
    // Arrange
    const chosenVerdict = "approve" as const
    const isSubmitted = true

    // Act
    render(
      <ReviewTray
        view={reviewedView()}
        chosenVerdict={chosenVerdict}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={() => {}}
        {...IDLE_SUBMIT_PROPS}
        isSubmitted={isSubmitted}
      />
    )

    // Assert — no second Submit button to post another review over the first.
    expect(screen.getByText("✓ Review submitted to GitHub")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Submit review" })).not.toBeInTheDocument()
  })

  it("keeps the dialog open with the reason when the submit fails", async () => {
    // Arrange
    const chosenVerdict = "approve" as const
    const submitError = "GitHub rejected the review: pull request is closed"
    render(
      <ReviewTray
        view={reviewedView()}
        chosenVerdict={chosenVerdict}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={() => {}}
        {...IDLE_SUBMIT_PROPS}
        submitError={submitError}
      />
    )

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }))

    // Assert — nothing was posted, so the reviewer is told why and can retry.
    expect(screen.getByRole("alert")).toHaveTextContent(submitError)
    expect(screen.getByRole("dialog", { name: "Confirm review submission" })).toBeInTheDocument()
  })
})

describe("ReviewTray degraded GitHub Viewed sync", () => {
  it("keeps the checkmarks and warns that GitHub is out of sync", () => {
    // Arrange — the checkmarks are the reviewer's own state; a failed mirror must not undo them.
    const viewedSyncError = "Resource not accessible by personal access token"
    const view = reviewedView()

    // Act
    render(
      <ReviewTray
        view={view}
        chosenVerdict={null}
        approveDisabled={false}
        onToggleReviewed={() => {}}
        onOpenFile={() => {}}
        activePath=""
        queueMode="foundations"
        onChooseQueueMode={() => {}}
        onHide={() => {}}
        onChooseVerdict={() => {}}
        onSubmit={() => {}}
        {...IDLE_SUBMIT_PROPS}
        viewedSyncError={viewedSyncError}
      />
    )

    // Assert — the 6/6 count still stands, beside a warning that says only the mirror is behind.
    const expectedCount = "6/6"
    expect(screen.getByText(expectedCount)).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(viewedSyncError)
    expect(screen.getByRole("status")).toHaveTextContent("Checkmarks saved here")
  })
})
