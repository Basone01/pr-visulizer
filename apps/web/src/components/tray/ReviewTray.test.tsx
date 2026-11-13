import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { PrView } from "@/entity/viewModels"

import { ReviewTray } from "./ReviewTray"
import { IDLE_SUBMIT_PROPS } from "./reviewTrayTestProps"

// The own-PR Approve guard (docs/architecture.md §11, task 4): GitHub rejects approving your
// own PR, so when viewer === author the Approve verdict is disabled with a tooltip while the
// other two verdicts stay live. The render proves the disabled state and its reason.

const OWN_PR_APPROVE_HINT = "GitHub doesn't allow approving your own PR"

function emptyView(): PrView {
  return {
    trayRows: [],
    fileNodes: [],
    ghostNodes: [],
    suggestedPath: null,
    reviewedCount: 1,
    totalCount: 1,
    allReviewed: true,
    generatedCount: 0,
    factsByPath: null,
  }
}

describe("ReviewTray Approve guard (author === viewer)", () => {
  it("disables Approve with the own-PR tooltip and keeps Comment / Request changes enabled", () => {
    // Arrange
    const view = emptyView()
    const approveDisabled = true

    // Act
    render(
      <ReviewTray
        view={view}
        chosenVerdict={null}
        approveDisabled={approveDisabled}
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

    // Assert
    const approveButton = screen.getByRole("button", { name: "Approve" })
    expect(approveButton).toBeDisabled()
    expect(approveButton).toHaveAttribute("title", OWN_PR_APPROVE_HINT)
    expect(screen.getByRole("button", { name: "Comment" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeEnabled()
  })

  it("leaves Approve enabled when the viewer is not the author", () => {
    // Arrange
    const view = emptyView()
    const approveDisabled = false

    // Act
    render(
      <ReviewTray
        view={view}
        chosenVerdict={null}
        approveDisabled={approveDisabled}
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

    // Assert
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled()
  })
})
