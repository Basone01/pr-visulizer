import type { DiffLine, ParsedDiff } from "@/entity/diff"

import { pairChangedLines } from "./pairChangedLines"

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

// Align one del-run with the add-run that immediately follows it, through the SAME similarity
// pairing the intra-line emphasis uses (pairChangedLines). Sharing it is the point: the emphasis
// says which two lines are counterparts, and this view has to seat those two lines on one row —
// pairing positionally here would put a removed line across from a line the other transform has
// already decided it has nothing to do with.
//
// Lines the alignment leaves unpaired are a real deletion or a real insertion and get an empty
// cell opposite, exactly as an unbalanced run has always rendered. Order is preserved throughout.
function alignRegion(dels: SideBySideCell[], adds: SideBySideCell[]): SideBySideRow[] {
  const pairs = pairChangedLines(
    dels.map((cell) => cell.line.content),
    adds.map((cell) => cell.line.content)
  )
  const addForDel = new Map(pairs.map(({ delIndex, addIndex }) => [delIndex, addIndex]))

  const rows: SideBySideRow[] = []
  let delIndex = 0
  let addIndex = 0

  while (delIndex < dels.length || addIndex < adds.length) {
    // Nothing left to remove — every remaining addition is a pure insertion.
    if (delIndex >= dels.length) {
      rows.push({ kind: "pair", left: null, right: adds[addIndex]! })
      addIndex += 1
      continue
    }

    const partner = addForDel.get(delIndex)

    if (partner === addIndex) {
      rows.push({ kind: "pair", left: dels[delIndex]!, right: adds[addIndex]! })
      delIndex += 1
      addIndex += 1
      continue
    }

    // This removal has no counterpart at all: it takes its own row now, ahead of the additions,
    // which is where the parse already put it.
    if (partner === undefined) {
      rows.push({ kind: "pair", left: dels[delIndex]!, right: null })
      delIndex += 1
      continue
    }

    // Its counterpart is a LATER addition, so the additions before it are pure insertions and
    // take their own rows first — both columns stay in file order.
    rows.push({ kind: "pair", left: null, right: adds[addIndex]! })
    addIndex += 1
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
