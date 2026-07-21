// A live line-range selection in the diff, tracked by head-version line numbers — the side
// GitHub anchors a review comment to (docs/architecture.md §11). `anchor` is where the
// selection started (the first clicked line); `focus` is the most recently extended line. The
// visible range is min..max of the two, so completing a range ABOVE the anchor selects upward
// just as naturally as downward. Pure data + pure transitions — the whole state machine.

// A range is picked with TWO CLICKS, not a drag. `phase` is what makes that unambiguous:
//
// - "anchored" — one line is picked and the composer is already open on it. The next plain
//   gutter click completes a range from the anchor to that line.
// - "ranged" — the range is complete. The next plain gutter click starts a FRESH selection
//   instead of stretching this one, so a reviewer can move to another line without having to
//   press Escape first.
//
// Shift-click ignores the phase and always extends from the anchor — that is how it already
// behaved, and how list selection behaves everywhere else.
export type SelectionPhase = "anchored" | "ranged"

export type LineSelection = {
  anchor: number
  focus: number
  phase: SelectionPhase
}

export type LineRange = {
  startLine: number
  endLine: number
}

// Start a fresh single-line selection at the clicked line, ready to be completed into a range.
export function beginSelection(line: number): LineSelection {
  return { anchor: line, focus: line, phase: "anchored" }
}

// Extend an existing selection to a new line (shift-click, or the second click of a range),
// keeping the original anchor. With nothing selected yet an extend simply begins — there is
// no anchor to hold.
export function extendSelection(selection: LineSelection | null, line: number): LineSelection {
  if (!selection) return beginSelection(line)

  return { anchor: selection.anchor, focus: line, phase: "ranged" }
}

// The plain (no modifier) gutter click — the whole click-click interaction in one function:
// first click anchors, second click completes the range, a click after that starts over.
// Clicking the SAME line twice completes it as a single-line comment, which is the common
// case and must never turn into a surprise range.
export function selectLine(selection: LineSelection | null, line: number): LineSelection {
  if (!selection || selection.phase === "ranged") return beginSelection(line)

  return extendSelection(selection, line)
}

// The normalized inclusive range (startLine <= endLine), regardless of which end was clicked
// first.
export function selectionRange(selection: LineSelection): LineRange {
  return {
    startLine: Math.min(selection.anchor, selection.focus),
    endLine: Math.max(selection.anchor, selection.focus),
  }
}

export function isLineInSelection(selection: LineSelection | null, line: number): boolean {
  if (!selection) return false

  const { startLine, endLine } = selectionRange(selection)
  return line >= startLine && line <= endLine
}
