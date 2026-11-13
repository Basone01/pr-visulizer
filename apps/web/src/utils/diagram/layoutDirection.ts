// Which way a flow diagram runs, from the inline size of the block that holds it: top-to-bottom
// in a narrow panel, left-to-right from 720 px. A band of ±16 px around the line keeps a drag
// across it from flipping the layout back and forth.

export type LayoutDirection = "down" | "right"

export const WIDE_LAYOUT_MIN_WIDTH = 720
const HYSTERESIS = 16

export function nextLayoutDirection(
  current: LayoutDirection | null,
  width: number
): LayoutDirection {
  if (current === "right") return width < WIDE_LAYOUT_MIN_WIDTH - HYSTERESIS ? "down" : "right"
  if (current === "down") return width >= WIDE_LAYOUT_MIN_WIDTH + HYSTERESIS ? "right" : "down"

  return width >= WIDE_LAYOUT_MIN_WIDTH ? "right" : "down"
}
