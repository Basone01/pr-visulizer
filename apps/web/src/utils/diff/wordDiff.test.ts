import { describe, expect, it } from "vitest"

import type { CharRange } from "./pairChangedLines"
import { type WordRanges, changedWordRanges } from "./wordDiff"

// The promise: word-level highlights mark EXACTLY the changed tokens. Each case shows the two
// lines and the text each expected range cuts out, so a reviewer sees the highlight at a glance.

function textOf(line: string, ranges: CharRange[]): string[] {
  return ranges.map((range) => line.slice(range.start, range.end))
}

describe("changedWordRanges — word highlights mark exactly the changed tokens", () => {
  it("marks the added 'final ' and ': Sendable' and nothing between them", () => {
    // Arrange — line 5 -> 6 of the JetBrains reference screenshot.
    const before = "class FrameStore {"
    const after = "final class FrameStore: Sendable {"

    // Act
    const ranges = changedWordRanges(before, after)!

    // Assert
    const expected = { before: [], after: ["final ", ": Sendable"] }
    expect({ before: textOf(before, ranges.before), after: textOf(after, ranges.after) }).toEqual(
      expected
    )
  })

  it("marks ', Sendable' as one run inside a conformance list", () => {
    // Arrange — line 7 -> 8 of the reference.
    const before = "  enum FrameCachingStrategy: Equatable {"
    const after = "  enum FrameCachingStrategy: Equatable, Sendable {"

    // Act
    const ranges = changedWordRanges(before, after)!

    // Assert
    const expected = [", Sendable"]
    expect(textOf(after, ranges.after)).toEqual(expected)
  })

  it("marks a replaced word on both sides", () => {
    // Arrange
    const before = "const total = sum(items)"
    const after = "const total = count(items)"

    // Act
    const ranges = changedWordRanges(before, after)!

    // Assert
    const expected: WordRanges = {
      before: [{ start: 14, end: 17 }],
      after: [{ start: 14, end: 19 }],
    }
    expect(ranges).toEqual(expected)
  })

  it("marks two separate edits as two ranges, not one span across the middle", () => {
    // Arrange
    const before = "let a = load(path, true)"
    const after = "const a = load(path, false)"

    // Act
    const ranges = changedWordRanges(before, after)!

    // Assert
    const expected = { before: ["let", "true"], after: ["const", "false"] }
    expect({ before: textOf(before, ranges.before), after: textOf(after, ranges.after) }).toEqual(
      expected
    )
  })

  it("returns null for identical lines", () => {
    // Arrange
    const line = "return value"

    // Act
    const ranges = changedWordRanges(line, line)

    // Assert
    expect(ranges).toBeNull()
  })

  it("keeps an emoji whole when it is the changed token", () => {
    // Arrange
    const before = 'label = "🙂"'
    const after = 'label = "🎉"'

    // Act
    const ranges = changedWordRanges(before, after)!

    // Assert
    const expected = ["🎉"]
    expect(textOf(after, ranges.after)).toEqual(expected)
  })

  it("falls back to one prefix/suffix span on a line too long to match word by word", () => {
    // Arrange — 600 tokens per side, past the cap.
    const words = Array.from({ length: 300 }, (_, index) => `w${index}`)
    const before = words.join(" ")
    const after = `${before} extra`

    // Act
    const ranges = changedWordRanges(before, after)!

    // Assert
    const expected = [" extra"]
    expect(textOf(after, ranges.after)).toEqual(expected)
  })
})
