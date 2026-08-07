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
      // The range begins and ends inside this one token, so the box needs all four sides.
      { text: "1", changed: true, run: "only" },
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
    const expected: TextSegment[] = [{ text: "items", changed: true, run: "only" }]

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

// A changed run wider than one token: the renderer paints emphasis inside each token, so the run
// arrives as several segments. `run` is what lets those pieces draw as ONE box — without it each
// piece rings itself and a single change reads as a row of chips.

describe("splitByRanges — a run crossing token boundaries", () => {
  // The line the user reported, tokenized the way a grammar splits it:
  //   `const sites = {"blog", "youtube", "threads"},`
  // with the range covering `, "threads"` — which starts inside one token and ends inside another.
  const CHANGED: CharRange[] = [{ start: 32, end: 43 }]

  it("marks the piece the range starts in as the run's START", () => {
    // Arrange — the token `"youtube",` sits at offset 23; the range opens on its final comma.
    const tokenText = '"youtube",'
    const tokenOffset = 23

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, CHANGED)

    // Assert
    const expected: TextSegment[] = [
      { text: '"youtube"', changed: false },
      { text: ",", changed: true, run: "start" },
    ]
    expect(segments).toEqual(expected)
  })

  it("marks a token fully inside the range as a MIDDLE piece, with no end of its own", () => {
    // Arrange — the space between the two strings is covered end to end.
    const tokenText = " "
    const tokenOffset = 33

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, CHANGED)

    // Assert
    const expected: TextSegment[] = [{ text: " ", changed: true, run: "mid" }]
    expect(segments).toEqual(expected)
  })

  it("marks the piece the range ends in as the run's END", () => {
    // Arrange — the last token carries the rest of the range plus the untouched `},` suffix.
    const tokenText = '"threads"},'
    const tokenOffset = 34

    // Act
    const segments = splitByRanges(tokenText, tokenOffset, CHANGED)

    // Assert
    const expected: TextSegment[] = [
      { text: '"threads"', changed: true, run: "end" },
      { text: "},", changed: false },
    ]
    expect(segments).toEqual(expected)
  })
})

// The reported shape: a hunk that deletes one line and adds TWO — an unrelated comment first,
// then the real replacement. Paired positionally the deletion met the comment, the two were far
// too different to be counterparts, and the whole region lost its emphasis.

describe("buildIntraLineRanges — the counterpart is not the first added line", () => {
  const PATCH = [
    "@@ -1,1 +1,2 @@",
    '-supportChannels := []string{"blog", "youtube"}',
    "+// Threads is the newest support channel.",
    '+supportChannels := []string{"blog", "youtube", "threads"}',
  ].join("\n")

  it("emphasizes the line that actually changed, below the inserted comment", () => {
    // Arrange — before the alignment this region produced NO ranges at all: the deletion was
    // pitted against the comment and gave up. The removed line still carries none of its own,
    // because nothing was removed FROM it — the channel list only gained an entry (same rule as
    // "a pure insertion gets a range on the add side only" above).
    const parsed = parseUnifiedDiff(PATCH)
    const modifiedAddLineIndex = 3

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    const emphasizedIndexes = [...ranges.keys()].sort((a, b) => a - b)
    const expected = [modifiedAddLineIndex]
    expect(emphasizedIndexes).toEqual(expected)
  })

  it("emphasizes exactly the added channel, not the whole line", () => {
    // Arrange
    const parsed = parseUnifiedDiff(PATCH)
    const modifiedAddLineIndex = 3
    const addedText = ', "threads"'

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    const range = ranges.get(modifiedAddLineIndex)![0]!
    const emphasized = parsed.lines[modifiedAddLineIndex]!.content.slice(range.start, range.end)
    expect(emphasized).toBe(addedText)
  })

  it("leaves the inserted comment unemphasized — it replaced nothing", () => {
    // Arrange
    const parsed = parseUnifiedDiff(PATCH)
    const commentLineIndex = 2

    // Act
    const ranges = buildIntraLineRanges(parsed)

    // Assert
    expect(ranges.has(commentLineIndex)).toBe(false)
  })
})
