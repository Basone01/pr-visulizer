import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { selectionRange } from "@/utils/comments/lineSelection"

import { useLineSelection } from "./useLineSelection"

// The line-range selection state machine (task 5): a plain gutter click selects one line, a
// SECOND plain click completes a range to it, a shift-click extends keeping the anchor, and
// Escape clears. The second-click behaviour replaced a drag that never worked in the app.

describe("useLineSelection", () => {
  it("selects a single line on the first click", () => {
    // Arrange
    const clickedLine = 5

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.select(clickedLine))

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
    act(() => result.current.select(anchorLine))
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
    act(() => result.current.select(anchorLine))
    act(() => result.current.extend(shiftClickedLine))

    // Assert
    const expected = { startLine: 2, endLine: 5 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("completes a range on a second plain click, without any modifier", () => {
    // Arrange
    const firstClickedLine = 5
    const secondClickedLine = 9

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.select(firstClickedLine))
    act(() => result.current.select(secondClickedLine))

    // Assert
    const expected = { startLine: 5, endLine: 9 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("completes a range upward when the second click is above the first", () => {
    // Arrange
    const firstClickedLine = 9
    const secondClickedLine = 5

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.select(firstClickedLine))
    act(() => result.current.select(secondClickedLine))

    // Assert
    const expected = { startLine: 5, endLine: 9 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("keeps a repeated click on the same line a single-line comment", () => {
    // Arrange
    const clickedLine = 5

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.select(clickedLine))
    act(() => result.current.select(clickedLine))

    // Assert
    const expected = { startLine: 5, endLine: 5 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("starts a fresh selection on the click after a range is complete", () => {
    // Arrange — without this, a reviewer could never comment elsewhere without pressing Escape.
    const firstClickedLine = 5
    const secondClickedLine = 9
    const thirdClickedLine = 20

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.select(firstClickedLine))
    act(() => result.current.select(secondClickedLine))
    act(() => result.current.select(thirdClickedLine))

    // Assert
    const expected = { startLine: 20, endLine: 20 }
    expect(selectionRange(result.current.selection!)).toEqual(expected)
  })

  it("clears the selection on Escape", () => {
    // Arrange
    const clickedLine = 5

    // Act
    const { result } = renderHook(() => useLineSelection())
    act(() => result.current.select(clickedLine))
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })))

    // Assert
    const expected = null
    expect(result.current.selection).toBe(expected)
  })
})
