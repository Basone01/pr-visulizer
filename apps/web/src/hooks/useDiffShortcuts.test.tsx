import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useDiffShortcuts } from "./useDiffShortcuts"

// Mounts the hook alongside a real textarea so a keystroke can originate from a text field
// (event.target === the field) exactly as it would from the comment composer.
function Harness({
  onToggleViewed,
  onOpenNext,
  enabled = true,
}: {
  onToggleViewed: () => void
  onOpenNext: () => void
  enabled?: boolean
}) {
  useDiffShortcuts({ enabled, onToggleViewed, onOpenNext })

  return <textarea aria-label="composer" defaultValue="" />
}

describe("useDiffShortcuts", () => {
  it("fires mark-viewed on Ctrl+1 and open-next on Ctrl+2", () => {
    // Arrange
    const onToggleViewed = vi.fn()
    const onOpenNext = vi.fn()
    render(<Harness onToggleViewed={onToggleViewed} onOpenNext={onOpenNext} />)

    // Act
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true })
    fireEvent.keyDown(document.body, { key: "2", ctrlKey: true })

    // Assert
    expect(onToggleViewed).toHaveBeenCalledTimes(1)
    expect(onOpenNext).toHaveBeenCalledTimes(1)
  })

  it("ignores the shortcut while a text field (comment composer) is focused", () => {
    // Arrange
    const onToggleViewed = vi.fn()
    const onOpenNext = vi.fn()
    render(<Harness onToggleViewed={onToggleViewed} onOpenNext={onOpenNext} />)
    const composer = screen.getByLabelText("composer")

    // Act — the keystroke comes from the textarea itself.
    fireEvent.keyDown(composer, { key: "1", ctrlKey: true })

    // Assert
    expect(onToggleViewed).not.toHaveBeenCalled()
  })

  it("does not fire when disabled (no file open)", () => {
    // Arrange
    const onToggleViewed = vi.fn()
    const onOpenNext = vi.fn()
    render(<Harness enabled={false} onToggleViewed={onToggleViewed} onOpenNext={onOpenNext} />)

    // Act
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true })

    // Assert
    expect(onToggleViewed).not.toHaveBeenCalled()
  })
})
