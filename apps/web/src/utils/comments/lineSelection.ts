// A live line-range selection in the diff, tracked by head-version line numbers — the side
// GitHub anchors a review comment to (docs/architecture.md §11). `anchor` is where the
// selection started (the clicked line); `focus` is the most recently extended line. The
// visible range is min..max of the two, so shift-clicking above the anchor selects upward
// just as naturally as downward. Pure data + pure transitions — the state machine for task 5.

export type LineSelection = {
  anchor: number
  focus: number
}

export type LineRange = {
  startLine: number
  endLine: number
}

// Start a fresh single-line selection at the clicked line.
export function beginSelection(line: number): LineSelection {
  return { anchor: line, focus: line }
}

// Extend an existing selection to a new line (shift-click / drag), keeping the original
// anchor. With nothing selected yet, an extend simply begins — there is no anchor to hold.
export function extendSelection(selection: LineSelection | null, line: number): LineSelection {
  if (!selection) return beginSelection(line)

  return { anchor: selection.anchor, focus: line }
}

// The normalized inclusive range (startLine <= endLine), regardless of drag direction.
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
