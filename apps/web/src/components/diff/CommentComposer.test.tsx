import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { CommentComposer } from "./CommentComposer"

// The inline composer (task 5): a textarea plus Add / Cancel, anchored to the selected range.
// Add forwards the trimmed body; Cancel discards.

describe("CommentComposer", () => {
  it("shows the range label and forwards the typed body to onSave", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const typedBody = "guard the null return"
    render(<CommentComposer startLine={3} endLine={6} onSave={onSave} onCancel={onCancel} />)

    // Act
    await user.type(screen.getByLabelText("Comment body"), typedBody)
    await user.click(screen.getByRole("button", { name: "Add" }))

    // Assert
    expect(screen.getByText("Comment on lines 3–6")).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledWith(typedBody)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("disables Add until there is non-whitespace text", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn()

    // Act
    render(<CommentComposer startLine={5} endLine={5} onSave={onSave} onCancel={() => {}} />)

    // Assert
    const addButton = screen.getByRole("button", { name: "Add" })
    expect(addButton).toBeDisabled()
    await user.type(screen.getByLabelText("Comment body"), "x")
    expect(addButton).toBeEnabled()
  })

  it("calls onCancel when Cancel is clicked", async () => {
    // Arrange
    const user = userEvent.setup()
    const onCancel = vi.fn()

    // Act
    render(<CommentComposer startLine={5} endLine={5} onSave={() => {}} onCancel={onCancel} />)
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    // Assert
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
