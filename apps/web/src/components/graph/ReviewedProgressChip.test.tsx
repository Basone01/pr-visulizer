import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ReviewedProgressChip } from "./ReviewedProgressChip"

describe("ReviewedProgressChip", () => {
  it("shows the reviewed/total count and opens the first unreviewed file on click", async () => {
    // Arrange
    const user = userEvent.setup()
    const reviewedCount = 3
    const totalCount = 7
    const firstUnreviewedPath = "src/auth/session.ts"
    const onOpen = vi.fn<(path: string) => void>()
    render(
      <ReviewedProgressChip
        reviewedCount={reviewedCount}
        totalCount={totalCount}
        firstUnreviewedPath={firstUnreviewedPath}
        onOpen={onOpen}
      />
    )

    // Assert — the count reads "reviewed/total".
    expect(screen.getByText("3/7")).toBeInTheDocument()

    // Act — clicking jumps to the first unreviewed file.
    await user.click(screen.getByRole("button"))

    // Assert
    expect(onOpen).toHaveBeenCalledWith(firstUnreviewedPath)
  })

  it("is disabled and fires no callback once every file is reviewed", async () => {
    // Arrange
    const user = userEvent.setup()
    const reviewedCount = 7
    const totalCount = 7
    const firstUnreviewedPath = null // null = nothing left unreviewed
    const onOpen = vi.fn<(path: string) => void>()
    render(
      <ReviewedProgressChip
        reviewedCount={reviewedCount}
        totalCount={totalCount}
        firstUnreviewedPath={firstUnreviewedPath}
        onOpen={onOpen}
      />
    )

    // Act
    const chip = screen.getByRole("button")
    await user.click(chip)

    // Assert — the full count still shows, but the chip is inert.
    expect(chip).toBeDisabled()
    expect(screen.getByText("7/7")).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
