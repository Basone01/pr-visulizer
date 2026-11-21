import type { DiffLine, ParsedDiff } from "@/entity/diff"

import { type CharRange, pairChangedLines } from "./pairChangedLines"
import { changedWordRanges } from "./wordDiff"

// Intra-line (character-level) diff emphasis (§10). A pure view-layer transform over the parse,
// like hideWhitespaceOnly and sideBySideRows: within each hunk it works out which removed line
// answers which added line — by SIMILARITY, through the shared pairChangedLines, so an unrelated
// line inserted among the adds cannot hide the real counterpart — and reports which characters
// differ inside each pair.
//
// It returns ranges keyed by the line's index in the flat ParsedDiff rather than a new line list:
// nothing about the diff changes, only what the renderer paints on top of it. The inline view and
// BOTH side-by-side columns address lines by that flat index, so one map serves every mode.

// Re-exported so the renderer keeps importing its range type from the module it paints for.
export type { CharRange } from "./pairChangedLines"

// Flat ParsedDiff line index -> the changed spans on that line. A line with nothing to emphasize
// is absent rather than mapped to an empty array, so a lookup miss is the common case.
export type IntraLineRanges = Map<number, CharRange[]>

// A side with no non-empty span only lost or gained text there (a pure insertion or deletion
// inside the line) — there is nothing to paint on it, so it stays out of the map.
function recordRanges(ranges: IntraLineRanges, lineIndex: number, lineRanges: CharRange[]): void {
  const painted = lineRanges.filter((range) => range.end > range.start)
  if (painted.length === 0) return

  ranges.set(lineIndex, painted)
}

function recordRegion(
  lines: DiffLine[],
  delIndices: number[],
  addIndices: number[],
  ranges: IntraLineRanges
): void {
  const pairs = pairChangedLines(
    delIndices.map((index) => lines[index]!.content),
    addIndices.map((index) => lines[index]!.content)
  )

  for (const { delIndex, addIndex } of pairs) {
    const delLineIndex = delIndices[delIndex]!
    const addLineIndex = addIndices[addIndex]!

    // Null here means the pair is identical — aligned, but with nothing to emphasize.
    const changed = changedWordRanges(lines[delLineIndex]!.content, lines[addLineIndex]!.content)
    if (!changed) continue

    recordRanges(ranges, delLineIndex, changed.before)
    recordRanges(ranges, addLineIndex, changed.after)
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

// Where a changed segment sits inside the range it came from, once that range has been cut at
// token boundaries. A range crossing tokens becomes SEVERAL segments — the emphasis is painted
// inside each token so syntax colour and anchors survive — and the renderer needs to know which
// edges to draw so those pieces read as one continuous box instead of a row of little chips.
export type RunPosition = "only" | "start" | "mid" | "end"

export type TextSegment = { text: string; changed: boolean; run?: RunPosition }

function runPositionOf(startsRun: boolean, endsRun: boolean): RunPosition {
  if (startsRun && endsRun) return "only"
  if (startsRun) return "start"
  if (endsRun) return "end"

  return "mid"
}

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

    // Compared in LINE coordinates: a range that started in an earlier token does not start here,
    // and one that runs past this token's end does not end here.
    const run = runPositionOf(offset + start === range.start, offset + end === range.end)
    segments.push({ text: text.slice(start, end), changed: true, run })
    cursor = end
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), changed: false })

  return segments
}
