import { act, renderHook } from "@testing-library/react"
import { createRef } from "react"
import { describe, expect, it } from "vitest"

import type { DiffLine } from "@/entity/diff"

import { useDiffFind } from "./useDiffFind"

function makeLines(contents: string[]): DiffLine[] {
  return contents.map((content, index) => ({
    kind: "context",
    content,
    oldLine: index + 1,
    newLine: index + 1,
  }))
}

describe("useDiffFind", () => {
  it("counts case-insensitive matches and cycles through them with next (wrapping)", () => {
    // Arrange
    const paneRef = createRef<HTMLElement>()
    const lines = makeLines(["alpha", "beta value", "gamma", "value tail", "delta"])
    const { result } = renderHook(() => useDiffFind(lines, paneRef))

    // Act — search for "VALUE" (matches rows 1 and 3, case-insensitively).
    act(() => result.current.setQuery("VALUE"))

    // Assert — two matches, the first is active.
    expect(result.current.matchCount).toBe(2)
    expect(result.current.activeDisplay).toBe(1)
    expect(result.current.currentRowIndex).toBe(1)

    // Act — next advances to the second match…
    act(() => result.current.next())

    // Assert
    expect(result.current.activeDisplay).toBe(2)
    expect(result.current.currentRowIndex).toBe(3)

    // Act — …and wraps back to the first.
    act(() => result.current.next())

    // Assert
    expect(result.current.activeDisplay).toBe(1)
    expect(result.current.currentRowIndex).toBe(1)
  })

  it("addresses a match far past the initial mounted window so it can be force-mounted", () => {
    // Arrange — one match on row 400, well beyond the progressive-mount first chunk.
    const paneRef = createRef<HTMLElement>()
    const farRow = 400
    const contents = Array.from({ length: 500 }, (_unused, index) =>
      index === farRow ? "the needle line" : `line ${index}`
    )
    const lines = makeLines(contents)
    const { result } = renderHook(() => useDiffFind(lines, paneRef))

    // Act
    act(() => result.current.setQuery("needle"))

    // Assert — DiffPane routes this row index through useProgressiveRows' requiredRow.
    expect(result.current.matchCount).toBe(1)
    expect(result.current.currentRowIndex).toBe(farRow)
  })

  it("reports no current row when nothing matches", () => {
    // Arrange
    const paneRef = createRef<HTMLElement>()
    const lines = makeLines(["one", "two", "three"])
    const { result } = renderHook(() => useDiffFind(lines, paneRef))

    // Act
    act(() => result.current.setQuery("zzz"))

    // Assert
    expect(result.current.matchCount).toBe(0)
    expect(result.current.activeDisplay).toBe(0)
    expect(result.current.currentRowIndex).toBe(-1)
  })
})
