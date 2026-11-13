import type { Rect } from "./layeredLayout"

// Pure arithmetic layout of a sequence diagram: one column per participant, one row per message
// in order. No elk: the order is the layout.

export type SequenceColumnInput = { headerWidth: number }

// `from` and `to` are column indexes; equal means a self-message.
export type SequenceRowInput = { from: number; to: number; labelWidth: number }

export type SequenceColumn = { center: number; header: Rect }

export type SequenceRow = {
  y: number
  fromX: number
  toX: number
  isSelf: boolean
  // Where the label's text starts: centered over the arrow, or right of a self-loop.
  label: { x: number; y: number; anchor: "middle" | "start" }
}

export type SequenceLayout = {
  width: number
  height: number
  columns: SequenceColumn[]
  lifelineTop: number
  lifelineBottom: number
  rows: SequenceRow[]
}

const OUTER_PADDING = 16
export const SEQUENCE_HEADER_HEIGHT = 40
// Clear space between two neighbouring headers; a message label widens its gap beyond this.
const MIN_COLUMN_GAP = 24
const LABEL_SIDE_ROOM = 24
const FIRST_ROW_OFFSET = 32
const ROW_HEIGHT = 40
const SELF_ROW_HEIGHT = 52
export const SELF_LOOP_WIDTH = 24
export const SELF_LOOP_HEIGHT = 20
const LABEL_GAP = 6

export function layoutSequence(
  columns: SequenceColumnInput[],
  rows: SequenceRowInput[]
): SequenceLayout {
  const gaps = columnGaps(columns, rows)
  const firstHalf = (columns[0]?.headerWidth ?? 0) / 2
  const centers: number[] = []
  let center = OUTER_PADDING + firstHalf
  columns.forEach((_, index) => {
    if (index > 0) center += gaps[index - 1] ?? 0
    centers.push(center)
  })

  const headerTop = OUTER_PADDING
  const placedColumns = columns.map((column, index) => {
    const columnCenter = centers[index] ?? 0
    return {
      center: columnCenter,
      header: {
        x: columnCenter - column.headerWidth / 2,
        y: headerTop,
        width: column.headerWidth,
        height: SEQUENCE_HEADER_HEIGHT,
      },
    }
  })

  const lifelineTop = headerTop + SEQUENCE_HEADER_HEIGHT
  let y = lifelineTop + FIRST_ROW_OFFSET
  const placedRows = rows.map((row) => {
    const fromX = centers[row.from] ?? 0
    const toX = centers[row.to] ?? 0
    const isSelf = row.from === row.to
    const placed: SequenceRow = {
      y,
      fromX,
      toX,
      isSelf,
      label: isSelf
        ? { x: fromX + SELF_LOOP_WIDTH + LABEL_GAP, y: y + SELF_LOOP_HEIGHT / 2, anchor: "start" }
        : { x: (fromX + toX) / 2, y: y - LABEL_GAP, anchor: "middle" },
    }
    y += isSelf ? SELF_ROW_HEIGHT : ROW_HEIGHT
    return placed
  })

  const lifelineBottom = y
  const selfLabelEnds = placedRows.map((row, index) =>
    row.isSelf ? row.label.x + (rows[index]?.labelWidth ?? 0) : 0
  )
  const rightmost = Math.max(
    ...placedColumns.map((column) => column.header.x + column.header.width),
    ...selfLabelEnds,
    0
  )

  return {
    width: Math.ceil(rightmost + OUTER_PADDING),
    height: Math.ceil(lifelineBottom + OUTER_PADDING),
    columns: placedColumns,
    lifelineTop,
    lifelineBottom,
    rows: placedRows,
  }
}

// Gap i is the distance between the centers of column i and i+1. Each starts wide enough for the
// two headers, then grows so every message label fits between its arrow's ends (spread evenly
// over the gaps the arrow spans), and so a self-message's label fits right of its loop.
function columnGaps(columns: SequenceColumnInput[], rows: SequenceRowInput[]): number[] {
  const gaps = columns.slice(1).map((column, index) => {
    const previous = columns[index]?.headerWidth ?? 0
    return previous / 2 + column.headerWidth / 2 + MIN_COLUMN_GAP
  })

  for (const row of rows) {
    const low = Math.min(row.from, row.to)
    const high = Math.max(row.from, row.to)

    if (low === high) {
      const needed = SELF_LOOP_WIDTH + LABEL_GAP + row.labelWidth + LABEL_SIDE_ROOM
      if (low < gaps.length) gaps[low] = Math.max(gaps[low] ?? 0, needed)
      continue
    }

    const spanned = gaps.slice(low, high)
    const needed = row.labelWidth + LABEL_SIDE_ROOM
    const deficit = needed - spanned.reduce((sum, gap) => sum + gap, 0)
    if (deficit <= 0) continue

    for (let index = low; index < high; index += 1)
      gaps[index] = (gaps[index] ?? 0) + deficit / spanned.length
  }

  return gaps.map((gap) => Math.ceil(gap))
}
