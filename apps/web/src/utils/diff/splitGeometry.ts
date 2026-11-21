// Geometry for the side-by-side view's ribbons and synced scrolling (§10). Pure numbers in, pure
// numbers out: the component measures the DOM and hands the measurements here, so the shape of a
// ribbon and the scroll mapping are testable without a browser.

// Where one change block sits on each side, in pixels from the top of that pane's CONTENT (not
// its viewport). An empty side has top === bottom: the insertion point.
export type BlockEdges = {
  leftTop: number
  leftBottom: number
  rightTop: number
  rightBottom: number
}

// A ribbon across a gutter `width` wide, between a block's left and right ranges, both already
// shifted into viewport coordinates. Each long edge is one cubic curve whose control points sit
// at the gutter's middle, so the band leaves and enters each side horizontally. A block that is
// empty on one side collapses to a point there, which draws the insertion wedge.
export function ribbonPath(edges: BlockEdges, width: number): string {
  const middle = width / 2
  const { leftTop, leftBottom, rightTop, rightBottom } = edges

  return [
    `M 0 ${leftTop}`,
    `C ${middle} ${leftTop} ${middle} ${rightTop} ${width} ${rightTop}`,
    `L ${width} ${rightBottom}`,
    `C ${middle} ${rightBottom} ${middle} ${leftBottom} 0 ${leftBottom}`,
    "Z",
  ].join(" ")
}

// Where a row was on screen when it was measured (getBoundingClientRect), in CSS pixels.
export type ScreenSpan = { top: number; bottom: number }

// What one pane looked like at the moment of measuring: where the ribbon surface's top edge was
// on screen, and how far that pane was scrolled.
export type PaneFrame = { surfaceTop: number; scrollTop: number }

// A measured row in the pane's scroll-invariant CONTENT coordinate, counted from the ribbon
// surface's top. Measuring against the surface (not with offsetTop inside the content) is the
// point: the pane's padding, any border and every fractional row height are then part of the
// number, so a ribbon drawn at `top - scrollTop` lands exactly on the row's edge. offsetTop
// left out the pane's 4px top padding and rounded 20.4px rows to whole pixels, which put every
// ribbon about 4px above its rows on both sides.
export function toContentSpan(span: ScreenSpan, frame: PaneFrame): ScreenSpan {
  const offset = frame.scrollTop - frame.surfaceTop

  return { top: span.top + offset, bottom: span.bottom + offset }
}

// Shift a block from content coordinates into each pane's viewport.
export function edgesInViewport(
  edges: BlockEdges,
  leftScroll: number,
  rightScroll: number
): BlockEdges {
  return {
    leftTop: edges.leftTop - leftScroll,
    leftBottom: edges.leftBottom - leftScroll,
    rightTop: edges.rightTop - rightScroll,
    rightBottom: edges.rightBottom - rightScroll,
  }
}

// Whether any part of a block (on either side) is inside a viewport `height` tall. A ribbon whose
// both ends are off screen is skipped, so a long file only draws what is visible.
export function isBlockVisible(edges: BlockEdges, height: number): boolean {
  const top = Math.min(edges.leftTop, edges.rightTop)
  const bottom = Math.max(edges.leftBottom, edges.rightBottom)

  return bottom >= 0 && top <= height
}

export type PaneSide = "left" | "right"

// One point known to line up on both sides: a block's top edges, or its bottom edges.
export type ScrollAnchor = { left: number; right: number }

// Every block contributes its top pair and its bottom pair, and every context line the pair of
// its two tops (`contextTops`). Lines between two anchors map linearly. Context anchors matter when
// one side wraps a line differently (the head side's usages pill narrows it), so every unchanged
// line lines up exactly, not only the edges of the blocks around it.
export function scrollAnchors(
  blocks: BlockEdges[],
  contextTops: ScrollAnchor[] = []
): ScrollAnchor[] {
  const blockAnchors = blocks.flatMap((block) => [
    { left: block.leftTop, right: block.rightTop },
    { left: block.leftBottom, right: block.rightBottom },
  ])

  // Both lists are in file order on both sides, so sorting by left (then right) interleaves them
  // without ever making the right side go backwards.
  return [{ left: 0, right: 0 }, ...blockAnchors, ...contextTops].sort(
    (first, second) => first.left - second.left || first.right - second.right
  )
}

function otherSide(side: PaneSide): PaneSide {
  return side === "left" ? "right" : "left"
}

// The y on the OTHER side that lines up with `y` on `from`. Inside an anchor segment it
// interpolates. Across an insertion (a zero-length segment on `from`) it jumps to the far end.
// Past the last anchor it keeps the last offset, since everything after is unchanged context.
export function mapAcross(y: number, anchors: ScrollAnchor[], from: PaneSide): number {
  const to = otherSide(from)

  let segment = 0
  while (segment + 1 < anchors.length && anchors[segment + 1]![from] <= y) segment += 1

  const start = anchors[segment]!
  const end = anchors[segment + 1]
  if (!end) return y - start[from] + start[to]

  const span = end[from] - start[from]
  const progress = span === 0 ? 0 : (y - start[from]) / span

  return start[to] + progress * (end[to] - start[to])
}

// The scrollTop the follower pane should take so that the line at the driver's vertical
// MIDDLE lines up on both sides, which keeps the ribbons near the reader's eye short.
export function followerScrollTop(
  driverScrollTop: number,
  viewportHeight: number,
  anchors: ScrollAnchor[],
  driver: PaneSide
): number {
  const middle = viewportHeight / 2

  return mapAcross(driverScrollTop + middle, anchors, driver) - middle
}
