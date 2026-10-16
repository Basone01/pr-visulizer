import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useDiffShortcuts } from "./useDiffShortcuts"

// Mounts the hook alongside a real textarea so a keystroke can originate from a text field
// (event.target === the field) exactly as it would from the comment composer.
function Harness({
  onToggleViewed,
  onOpenNext,
  onOlderChange = () => {},
  onNewerChange = () => {},
  enabled = true,
}: {
  onToggleViewed: () => void
  onOpenNext: () => void
  onOlderChange?: () => void
  onNewerChange?: () => void
  enabled?: boolean
}) {
  useDiffShortcuts({ enabled, onToggleViewed, onOpenNext, onOlderChange, onNewerChange })

  return <textarea aria-label="composer" defaultValue="" />
}

describe("useDiffShortcuts", () => {
  it("fires mark-viewed on Option+1 and open-next on Option+2", () => {
    // Arrange
    const onToggleViewed = vi.fn()
    const onOpenNext = vi.fn()
    render(<Harness onToggleViewed={onToggleViewed} onOpenNext={onOpenNext} />)

    // Act — key carries the macOS Option-composed character ("¡"/"™"), never the digit;
    // the hook must match on the physical code.
    fireEvent.keyDown(document.body, { key: "¡", code: "Digit1", altKey: true })
    fireEvent.keyDown(document.body, { key: "™", code: "Digit2", altKey: true })

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
    fireEvent.keyDown(composer, { key: "¡", code: "Digit1", altKey: true })

    // Assert
    expect(onToggleViewed).not.toHaveBeenCalled()
  })

  it("does not fire when disabled (no file open)", () => {
    // Arrange
    const onToggleViewed = vi.fn()
    const onOpenNext = vi.fn()
    render(<Harness enabled={false} onToggleViewed={onToggleViewed} onOpenNext={onOpenNext} />)

    // Act
    fireEvent.keyDown(document.body, { key: "¡", code: "Digit1", altKey: true })

    // Assert
    expect(onToggleViewed).not.toHaveBeenCalled()
  })

  it("steps_file_history_older_on_option_comma_and_newer_on_option_period", () => {
    // Arrange
    const onOlderChange = vi.fn()
    const onNewerChange = vi.fn()
    render(
      <Harness
        onToggleViewed={vi.fn()}
        onOpenNext={vi.fn()}
        onOlderChange={onOlderChange}
        onNewerChange={onNewerChange}
      />
    )

    // Act
    fireEvent.keyDown(document.body, { key: "≤", code: "Comma", altKey: true })
    fireEvent.keyDown(document.body, { key: "≥", code: "Period", altKey: true })

    // Assert
    const expected = { older: 1, newer: 1 }
    expect({
      older: onOlderChange.mock.calls.length,
      newer: onNewerChange.mock.calls.length,
    }).toEqual(expected)
  })
})
