import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { selectionRange } from "@/utils/comments/lineSelection"

import { useLineSelection } from "./useLineSelection"

// The line-range selection state machine (task 5): a click selects one line, a shift-click /
// drag extends the range keeping the anchor, and Escape clears it.

describe("useLineSelection", () => {
  it("selects a single line on begin", () => {
    // Arrange
    const clickedLine = 5

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.begin(clickedLine))

    // Assert
    const expected = { startLine: 5, endLine: 5 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("extends the range to the shift-clicked line while keeping the anchor", () => {
    // Arrange
    const anchorLine = 5
    const shiftClickedLine = 9

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.begin(anchorLine))
    act(() => result.current.extend(shiftClickedLine))

    // Assert
    const expected = { startLine: 5, endLine: 9 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("extends upward when the shift-click is above the anchor", () => {
    // Arrange
    const anchorLine = 5
    const shiftClickedLine = 2

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.begin(anchorLine))
    act(() => result.current.extend(shiftClickedLine))

    // Assert
    const expected = { startLine: 2, endLine: 5 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("clears the selection on Escape", () => {
    // Arrange
    const clickedLine = 5

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.begin(clickedLine))
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })))

    // Assert
    const expected = null
    expect(result.current.selection).toBe(expected)
  })
})
