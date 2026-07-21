import type { DiffLine, ParsedDiff } from "@/entity/diff"

// The side-by-side (split) view transform (§10). Like fullFileView and hideWhitespaceOnly this
// is a pure function over the parse, so it CHAINS after them: full-file re-renders the patch over
// the whole head file, hide-whitespace collapses the whitespace-only pairs, and this pairs what
// is left into base-left / head-right rows.
//
// Unlike those two it does NOT return a ParsedDiff: pairing changes the render shape (rows of two
// cells), not the line model. Every emitted cell is the SAME DiffLine the parse produced — no
// renumbering, no rewriting — so symbol anchors, drafts and find keep resolving off `newLine`.

// A cell keeps the line's index in the flat ParsedDiff it came from. Find, the flash highlight and
// the progressive mount budget all address rows by that flat index, so the pairing must not lose
// it — a pair of a 3-line deletion with a 1-line addition scrambles the flat order across rows.
export type SideBySideCell = {
  line: DiffLine
  index: number
}

// A hunk header spans both columns; every other row is a pair, either side of which may be empty
// (an unpaired deletion has no head line to sit beside, and vice versa).
export type SideBySideRow =
  | { kind: "hunk"; header: SideBySideCell }
  | { kind: "pair"; left: SideBySideCell | null; right: SideBySideCell | null }

// A context line is one line shown on BOTH sides — the same cell, rendered twice with a different
// gutter. Pairing it rather than duplicating it keeps the two columns on the same physical row.
function pairContext(cell: SideBySideCell): SideBySideRow {
  return { kind: "pair", left: cell, right: cell }
}

// Align one del-run with the add-run that immediately follows it: the Nth removed line sits beside
// the Nth added line, and the longer run's remainder pairs with an empty filler cell. This is the
// same positional del/add pairing hideWhitespaceOnly uses, so the two agree on what "a pair" is.
function alignRegion(dels: SideBySideCell[], adds: SideBySideCell[]): SideBySideRow[] {
  const rowCount = Math.max(dels.length, adds.length)
  const rows: SideBySideRow[] = []

  for (let index = 0; index < rowCount; index += 1) {
    rows.push({ kind: "pair", left: dels[index] ?? null, right: adds[index] ?? null })
  }

  return rows
}

export function buildSideBySideRows(parsed: ParsedDiff): SideBySideRow[] {
  const { lines } = parsed
  const rows: SideBySideRow[] = []

  let index = 0
  while (index < lines.length) {
    const cell: SideBySideCell = { line: lines[index]!, index }

    if (cell.line.kind === "hunk") {
      rows.push({ kind: "hunk", header: cell })
      index += 1
      continue
    }

    if (cell.line.kind === "context") {
      rows.push(pairContext(cell))
      index += 1
      continue
    }

    // A change region: the maximal del-run, then the add-run that immediately follows it. A
    // pure-addition hunk enters here with an empty del-run, so its adds pair with empty left cells.
    const dels: SideBySideCell[] = []
    while (index < lines.length && lines[index]!.kind === "del") {
      dels.push({ line: lines[index]!, index })
      index += 1
    }

    const adds: SideBySideCell[] = []
    while (index < lines.length && lines[index]!.kind === "add") {
      adds.push({ line: lines[index]!, index })
      index += 1
    }

    rows.push(...alignRegion(dels, adds))
  }

  return rows
}

// Which row holds a given flat line index, or -1. Pairing breaks the flat order (row 0 of a
// 3-del/1-add region holds flat indices 0 and 3), so callers that hold a flat index — find's
// current match, the flash target, a peeked definition — translate it through here rather than
// assuming row index and line index line up.
export function findRowForLineIndex(rows: SideBySideRow[], lineIndex: number): number {
  if (lineIndex < 0) return -1

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!

    if (row.kind === "hunk") {
      if (row.header.index === lineIndex) return rowIndex
      continue
    }

    if (row.left?.index === lineIndex || row.right?.index === lineIndex) return rowIndex
  }

  return -1
}
