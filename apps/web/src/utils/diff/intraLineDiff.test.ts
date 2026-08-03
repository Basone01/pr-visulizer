import { describe, expect, it } from "vitest"

import { hideWhitespaceOnly } from "./hideWhitespaceOnly"
import {
  type CharRange,
  type TextSegment,
  buildIntraLineRanges,
  splitByRanges,
} from "./intraLineDiff"
import { parseUnifiedDiff } from "./parseUnifiedDiff"

// Arranged from real patch strings (the reviewer reads the diff shape directly) and asserted
// against the flat ParsedDiff index each range is keyed by — so which line got emphasized, and
// which characters on it, are both visible above the assert. Index 0 is always the hunk header.

// The map as entries, so the assert shows line index and ranges side by side.
type IntraLineExpectation = Array<[number, CharRange[]]>

describe("buildIntraLineRanges", () => {
  it("emphasizes only the characters that differ in a balanced pair", () => {
    // Arrange — one character changed at the end of an otherwise identical line.
    const patch = ["@@ -1,1 +1,1 @@", "-const x = 1", "+const x = 2"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const delLineIndex = 1
    const addLineIndex = 2
    const changedValue: CharRange = { start: 10, end: 11 }
    const expected: IntraLineExpectation = [
      [delLineIndex, [changedValue]],
      [addLineIndex, [changedValue]],
    ]

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    expect([...ranges]).toEqual(expected)
  })

  it("gives a pure insertion a range on the add side only", () => {
    // Arrange — an argument added mid-line: the removed line lost nothing, so it has nothing
    // to paint and stays out of the map entirely.
    const patch = ["@@ -1,1 +1,1 @@", "-call(a)", "+call(a, b)"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const addLineIndex = 2
    const insertedArgument: CharRange = { start: 6, end: 9 }
    const expected: IntraLineExpectation = [[addLineIndex, [insertedArgument]]]

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    expect([...ranges]).toEqual(expected)
  })

  it("bails out on a rewritten line rather than emphasizing all of it", () => {
    // Arrange — the two lines share no prefix and no suffix, so the "changed part" is the whole
    // line: emphasis there is noise, and MAX_CHANGED_FRACTION drops the pair.
    const patch = ["@@ -1,1 +1,1 @@", "-const total = sum(items)", "+return items.length"].join(
      "\n"
    )
    const parsed = parseUnifiedDiff(patch)
    const expected: IntraLineExpectation = []

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    expect([...ranges]).toEqual(expected)
  })

  it("pairs positionally and leaves the unpaired remainder alone", () => {
    // Arrange — 2 removed against 1 added: the 1st del pairs with the 1st add (same rule
    // sideBySideRows and hideWhitespaceOnly use), and the 2nd del has no counterpart.
    const patch = ["@@ -1,2 +1,1 @@", "-const a = 1", "-const b = 2", "+const a = 9"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const pairedDelIndex = 1
    const addLineIndex = 3
    const changedValue: CharRange = { start: 10, end: 11 }
    const expected: IntraLineExpectation = [
      [pairedDelIndex, [changedValue]],
      [addLineIndex, [changedValue]],
    ]

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert — the unpaired removal (flat index 2) is absent.
    expect([...ranges]).toEqual(expected)
  })

  it("emphasizes nothing in a hunk of pure additions", () => {
    // Arrange — with no removal to compare against there is no pair to diff.
    const patch = [
      "@@ -1,1 +1,3 @@",
      " const kept = 1",
      "+const first = 2",
      "+const second = 3",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: IntraLineExpectation = []

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    expect([...ranges]).toEqual(expected)
  })

  it("reads the line list hide-whitespace produced, not the original parse", () => {
    // Arrange — pair #1 is indentation-only and collapses to a context line; the real pair that
    // follows shifts down to flat indices 2 and 3, which is what the ranges must key by.
    const patch = ["@@ -1,2 +1,2 @@", "-  a = 1", "-b = 2", "+a = 1", "+b = 3"].join("\n")
    const shown = hideWhitespaceOnly(parseUnifiedDiff(patch))
    const delLineIndex = 2
    const addLineIndex = 3
    const changedValue: CharRange = { start: 4, end: 5 }
    const expected: IntraLineExpectation = [
      [delLineIndex, [changedValue]],
      [addLineIndex, [changedValue]],
    ]

    // Act
    const ranges = buildIntraLineRanges(shown)

    // Assert
    expect([...ranges]).toEqual(expected)
  })

  it("keeps an astral character whole instead of cutting its surrogate pair", () => {
    // Arrange — two emoji sharing a high surrogate. A raw common-prefix scan would stop between
    // the two halves and paint a lone replacement glyph; the range must cover both units.
    const patch = ["@@ -1,1 +1,1 @@", '-const emoji = "😀"', '+const emoji = "😃"'].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const delLineIndex = 1
    const addLineIndex = 2
    // `const emoji = "` is 15 UTF-16 units; the emoji occupies the next two.
    const wholeEmoji: CharRange = { start: 15, end: 17 }
    const expected: IntraLineExpectation = [
      [delLineIndex, [wholeEmoji]],
      [addLineIndex, [wholeEmoji]],
    ]

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    expect([...ranges]).toEqual(expected)
  })
})

describe("splitByRanges", () => {
  it("cuts a token at the boundaries of the range that overlaps it", () => {
    // Arrange — the token "= 1" sits at offset 8 of the line, and only its last character changed.
    const tokenText = "= 1"
    const tokenOffset = 8
    const changedValue: CharRange[] = [{ start: 10, end: 11 }]
    const expected: TextSegment[] = [
      { text: "= ", changed: false },
      { text: "1", changed: true },
    ]

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, changedValue)

    // Assert
    expect(segments).toEqual(expected)
  })

  it("returns one unchanged segment for a token no range touches", () => {
    // Arrange — the token ends before the changed span begins.
    const tokenText = "const"
    const tokenOffset = 0
    const changedValue: CharRange[] = [{ start: 10, end: 11 }]
    const expected: TextSegment[] = [{ text: "const", changed: false }]

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, changedValue)

    // Assert
    expect(segments).toEqual(expected)
  })

  it("marks a token that sits entirely inside the changed span", () => {
    // Arrange — the whole line changed between its prefix and suffix, and this token is in there.
    const tokenText = "items"
    const tokenOffset = 6
    const changedRegion: CharRange[] = [{ start: 6, end: 11 }]
    const expected: TextSegment[] = [{ text: "items", changed: true }]

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, changedRegion)

    // Assert
    expect(segments).toEqual(expected)
  })

  it("returns the text untouched when there are no ranges", () => {
    // Arrange — the toggle-off path: every line renders exactly as it did before.
    const tokenText = "const x = 1"
    const tokenOffset = 0
    const noRanges: CharRange[] = []
    const expected: TextSegment[] = [{ text: "const x = 1", changed: false }]

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, noRanges)

    // Assert
    expect(segments).toEqual(expected)
  })
})
