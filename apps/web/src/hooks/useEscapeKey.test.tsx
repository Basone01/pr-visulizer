import { act, renderHook } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"

import type { OccurrenceRef } from "@/entity/anchor"
import type { DiffLine } from "@/entity/diff"

import { useDiffFind } from "@/hooks/useDiffFind"
import { useLineSelection } from "@/hooks/useLineSelection"
import { usePeekNavigation } from "@/hooks/usePeekNavigation"

// One Escape keypress must reach exactly ONE consumer. These are the two regressions the
// precedence table fixes: the find bar's Escape used to also pop the jump stack (navigating the
// reviewer out of the file they were reading), and the line selection used to clear on every
// Escape whatever it was aimed at.

const LINES: DiffLine[] = [
  { kind: "context", content: "const value = 1", oldLine: 1, newLine: 1 },
  { kind: "add", content: "const result = helper(value)", oldLine: null, newLine: 2 },
]

// The real consumers, mounted together the way the diff pane mounts them.
function useEscapeConsumers() {
  const paneRef = useRef<HTMLDivElement>(null)
  const nav = usePeekNavigation("src/caller.ts")
  const find = useDiffFind(LINES, paneRef)
  const selection = useLineSelection()

  return { nav, find, selection }
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  })
}

function pressFindChord(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }))
  })
}

describe("Escape precedence across the diff's consumers", () => {
  it("closes the find bar without unwinding the jump stack", () => {
    // Arrange — the reviewer jumped into a definition, then opened find in that file.
    const jumpTarget: OccurrenceRef = { path: "src/helper.ts", line: 1 }
    const { result } = renderHook(() => useEscapeConsumers())
    act(() => result.current.nav.jumpTo(jumpTarget))
    pressFindChord()
    expect(result.current.find.open).toBe(true)

    // Act
    pressEscape()

    // Assert — the bar closed and the reviewer is still standing in the file they jumped to.
    const expectedPath = jumpTarget.path
    expect(result.current.find.open).toBe(false)
    expect(result.current.nav.state.current.path).toBe(expectedPath)
    expect(result.current.nav.state.jumpStack).toHaveLength(1)
  })

  it("leaves the line selection alone while the find bar owns Escape, and clears it on the next press", () => {
    // Arrange — a line range is selected (a comment draft in progress) and find is open over it.
    const selectedLine = 2
    const { result } = renderHook(() => useEscapeConsumers())
    act(() => result.current.selection.select(selectedLine))
    pressFindChord()

    // Act
    pressEscape()

    // Assert — only the bar closed; the selection survived.
    expect(result.current.find.open).toBe(false)
    expect(result.current.selection.selection).not.toBeNull()

    // Act — with the bar gone, the next Escape belongs to the selection.
    pressEscape()

    // Assert
    const expected = null
    expect(result.current.selection.selection).toBe(expected)
  })

  it("closes an open peek before touching the line selection", () => {
    // Arrange — peek outranks the selection, so the detour unwinds first.
    const selectedLine = 2
    const jumpTarget: OccurrenceRef = { path: "src/helper.ts", line: 1 }
    const { result } = renderHook(() => useEscapeConsumers())
    act(() => result.current.selection.select(selectedLine))
    act(() => result.current.nav.jumpTo(jumpTarget))

    // Act
    pressEscape()

    // Assert — the jump popped and the selection is untouched.
    expect(result.current.nav.state.jumpStack).toHaveLength(0)
    expect(result.current.selection.selection).not.toBeNull()
  })
})
