import type { DiffLine, ParsedDiff } from "@/entity/diff"

// Intra-line (character-level) diff emphasis (§10). A pure view-layer transform over the parse,
// like hideWhitespaceOnly and sideBySideRows: within each hunk it pairs the del-block with the
// add-block positionally (1st del with 1st add, …) — the same pairing those two use, so all
// three agree on what "a pair" is — and reports which characters differ inside each pair.
//
// It returns ranges keyed by the line's index in the flat ParsedDiff rather than a new line list:
// nothing about the diff changes, only what the renderer paints on top of it. The inline view and
// BOTH side-by-side columns address lines by that flat index, so one map serves every mode.

// Half-open [start, end) over a line's content, in UTF-16 code units — the units String.slice
// takes, so the renderer cuts tokens with it directly.
export type CharRange = { start: number; end: number }

// Flat ParsedDiff line index -> the changed spans on that line. A line with nothing to emphasize
// is absent rather than mapped to an empty array, so a lookup miss is the common case.
export type IntraLineRanges = Map<number, CharRange[]>

// Past this share of a line, the changed part IS the line: a rewritten line lights up end to end,
// which is noise rather than emphasis. Measured against the longer side, so a short line replaced
// wholesale bails out while a small edit inside a long line always survives.
const MAX_CHANGED_FRACTION = 0.75

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

// A common prefix that ends on a high surrogate would cut an astral character (an emoji in a
// string literal) in half, and half a pair renders as a replacement glyph — step back one unit.
function commonPrefixLength(before: string, after: string): number {
  const limit = Math.min(before.length, after.length)

  let length = 0
  while (length < limit && before[length] === after[length]) length += 1

  if (length > 0 && isHighSurrogate(before.charCodeAt(length - 1))) return length - 1

  return length
}

// `limit` keeps the suffix from reaching back into the prefix — without it "aaa" -> "aaaa" would
// claim the same characters twice and produce a negative-width range.
function commonSuffixLength(before: string, after: string, limit: number): number {
  let length = 0
  while (
    length < limit &&
    before[before.length - 1 - length] === after[after.length - 1 - length]
  ) {
    length += 1
  }

  // The suffix starts on a low surrogate whose high half is outside it — same split, same fix.
  if (length > 0 && isLowSurrogate(before.charCodeAt(before.length - length))) return length - 1

  return length
}

type PairRanges = { before: CharRange; after: CharRange }

// Everything between the common prefix and the common suffix changed. null means the pair is not
// worth emphasizing at all — identical text, or a rewrite that trips MAX_CHANGED_FRACTION.
function changedRangesForPair(before: string, after: string): PairRanges | null {
  if (before === after) return null

  const prefix = commonPrefixLength(before, after)
  const suffixLimit = Math.min(before.length, after.length) - prefix
  const suffix = commonSuffixLength(before, after, suffixLimit)

  const beforeChanged: CharRange = { start: prefix, end: before.length - suffix }
  const afterChanged: CharRange = { start: prefix, end: after.length - suffix }

  const longestLine = Math.max(before.length, after.length)
  const longestChange = Math.max(
    beforeChanged.end - beforeChanged.start,
    afterChanged.end - afterChanged.start
  )

  if (longestChange / longestLine > MAX_CHANGED_FRACTION) return null

  return { before: beforeChanged, after: afterChanged }
}

// A side with an empty span only lost or gained text there (a pure insertion or deletion inside
// the line) — there is nothing to paint on it, so it stays out of the map.
function recordRange(ranges: IntraLineRanges, lineIndex: number, range: CharRange): void {
  if (range.end <= range.start) return

  ranges.set(lineIndex, [range])
}

function recordRegion(
  lines: DiffLine[],
  delIndices: number[],
  addIndices: number[],
  ranges: IntraLineRanges
): void {
  const pairCount = Math.min(delIndices.length, addIndices.length)

  for (let position = 0; position < pairCount; position += 1) {
    const delIndex = delIndices[position]!
    const addIndex = addIndices[position]!

    const pair = changedRangesForPair(lines[delIndex]!.content, lines[addIndex]!.content)
    if (!pair) continue

    recordRange(ranges, delIndex, pair.before)
    recordRange(ranges, addIndex, pair.after)
  }
}

export function buildIntraLineRanges(parsed: ParsedDiff): IntraLineRanges {
  const { lines } = parsed
  const ranges: IntraLineRanges = new Map()

  let index = 0
  while (index < lines.length) {
    if (lines[index]!.kind !== "del") {
      index += 1
      continue
    }

    // The maximal del-block, then the add-block that immediately follows it. A pure-addition
    // region never enters here — with no deletion to compare against there is no pair to diff.
    const delIndices: number[] = []
    while (index < lines.length && lines[index]!.kind === "del") {
      delIndices.push(index)
      index += 1
    }

    const addIndices: number[] = []
    while (index < lines.length && lines[index]!.kind === "add") {
      addIndices.push(index)
      index += 1
    }

    recordRegion(lines, delIndices, addIndices, ranges)
  }

  return ranges
}

export type TextSegment = { text: string; changed: boolean }

// Cut one piece of a line — a shiki token, or the whole line on the plain-text path — at the
// range boundaries falling inside it. `offset` is where the piece starts in the line, since a
// token carries its text but not its position. Ranges must be ascending and non-overlapping,
// which is what buildIntraLineRanges emits.
export function splitByRanges(text: string, offset: number, ranges: CharRange[]): TextSegment[] {
  if (ranges.length === 0 || text.length === 0) return [{ text, changed: false }]

  const segments: TextSegment[] = []
  let cursor = 0

  for (const range of ranges) {
    const start = Math.max(range.start - offset, cursor)
    const end = Math.min(range.end - offset, text.length)
    if (end <= start) continue

    if (start > cursor) segments.push({ text: text.slice(cursor, start), changed: false })

    segments.push({ text: text.slice(start, end), changed: true })
    cursor = end
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), changed: false })

  return segments
}
