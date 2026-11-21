import { describe, expect, it } from "vitest"

import {
  type BlockEdges,
  type PaneFrame,
  type ScreenSpan,
  edgesInViewport,
  followerScrollTop,
  isBlockVisible,
  mapAcross,
  ribbonPath,
  scrollAnchors,
  toContentSpan,
} from "./splitGeometry"

// The promise: both panes scroll in sync so a ribbon keeps joining the lines it pairs.
// Pixel positions use a 20px line height so each number reads as "line N".

const LINE = 20

describe("ribbonPath — a ribbon joins a left block to the right block it became", () => {
  it("runs from the left range to the right range across the gutter", () => {
    // Arrange — 1 line on the left (line 5) became 2 lines on the right (lines 6..7).
    const edges: BlockEdges = {
      leftTop: 5 * LINE,
      leftBottom: 6 * LINE,
      rightTop: 6 * LINE,
      rightBottom: 8 * LINE,
    }
    const gutterWidth = 40

    // Act
    const path = ribbonPath(edges, gutterWidth)

    // Assert
    const expected = "M 0 100 C 20 100 20 120 40 120 L 40 160 C 20 160 20 120 0 120 Z"
    expect(path).toBe(expected)
  })

  it("collapses to a wedge at the insertion point when the left side is empty", () => {
    // Arrange — one line inserted on the right after left line 4.
    const insertionPoint = 4 * LINE
    const edges: BlockEdges = {
      leftTop: insertionPoint,
      leftBottom: insertionPoint,
      rightTop: 4 * LINE,
      rightBottom: 5 * LINE,
    }
    const gutterWidth = 40

    // Act
    const path = ribbonPath(edges, gutterWidth)

    // Assert
    const expected = "M 0 80 C 20 80 20 80 40 80 L 40 100 C 20 100 20 80 0 80 Z"
    expect(path).toBe(expected)
  })
})

describe("isBlockVisible", () => {
  it("skips a block whose both sides are above the viewport", () => {
    // Arrange
    const edges: BlockEdges = { leftTop: -80, leftBottom: -60, rightTop: -40, rightBottom: -20 }
    const viewportHeight = 400

    // Act
    const visible = isBlockVisible(edges, viewportHeight)

    // Assert
    expect(visible).toBe(false)
  })

  it("draws a block that is visible on one side only", () => {
    // Arrange — off screen on the left, on screen on the right.
    const edges: BlockEdges = { leftTop: -80, leftBottom: -60, rightTop: 10, rightBottom: 30 }
    const viewportHeight = 400

    // Act
    const visible = isBlockVisible(edges, viewportHeight)

    // Assert
    expect(visible).toBe(true)
  })
})

describe("mapAcross — both panes scroll in sync", () => {
  // One inserted line on the right at line 4, then a 1 -> 2 line modification at left line 10.
  const blocks: BlockEdges[] = [
    { leftTop: 4 * LINE, leftBottom: 4 * LINE, rightTop: 4 * LINE, rightBottom: 5 * LINE },
    { leftTop: 10 * LINE, leftBottom: 11 * LINE, rightTop: 11 * LINE, rightBottom: 13 * LINE },
  ]
  const anchors = scrollAnchors(blocks)

  it("maps context before any change to the same line", () => {
    // Arrange
    const leftY = 2 * LINE

    // Act
    const rightY = mapAcross(leftY, anchors, "left")

    // Assert
    const expected = 2 * LINE
    expect(rightY).toBe(expected)
  })

  it("maps context between two blocks one line down, past the insertion", () => {
    // Arrange
    const leftY = 7 * LINE

    // Act
    const rightY = mapAcross(leftY, anchors, "left")

    // Assert
    const expected = 8 * LINE
    expect(rightY).toBe(expected)
  })

  it("holds the left side at the insertion point while the right scrolls through it", () => {
    // Arrange — halfway down the inserted right line.
    const rightY = 4.5 * LINE

    // Act
    const leftY = mapAcross(rightY, anchors, "right")

    // Assert
    const expected = 4 * LINE
    expect(leftY).toBe(expected)
  })

  it("stretches a 1-line left block over its 2-line right block", () => {
    // Arrange — halfway down the left line 10.
    const leftY = 10.5 * LINE

    // Act
    const rightY = mapAcross(leftY, anchors, "left")

    // Assert
    const expected = 12 * LINE
    expect(rightY).toBe(expected)
  })

  it("keeps the last offset after the final block", () => {
    // Arrange
    const leftY = 30 * LINE

    // Act
    const rightY = mapAcross(leftY, anchors, "left")

    // Assert
    const expected = 32 * LINE
    expect(rightY).toBe(expected)
  })

  it("lines the follower up at the driver's vertical middle", () => {
    // Arrange — the left pane scrolled so its middle sits on left line 7.
    const viewportHeight = 10 * LINE
    const driverScrollTop = 2 * LINE

    // Act
    const scrollTop = followerScrollTop(driverScrollTop, viewportHeight, anchors, "left")

    // Assert — right line 8 sits at the right pane's middle.
    const expected = 3 * LINE
    expect(scrollTop).toBe(expected)
  })
})

describe("scrollAnchors — context lines line up even when they wrap differently", () => {
  it("maps an unchanged line to its own top on the other side, not an interpolated guess", () => {
    // Arrange — no blocks, but the head side wraps line 2 onto two rows, so line 3 sits one row
    // lower on the right. Without a context anchor, line 3 would map to the left's line 3 top.
    const blocks: BlockEdges[] = []
    const contextTops = [
      { left: 0 * LINE, right: 0 * LINE },
      { left: 1 * LINE, right: 1 * LINE },
      { left: 2 * LINE, right: 3 * LINE },
    ]
    const anchors = scrollAnchors(blocks, contextTops)
    const leftY = 2 * LINE

    // Act
    const rightY = mapAcross(leftY, anchors, "left")

    // Assert
    const expected = 3 * LINE
    expect(rightY).toBe(expected)
  })
})

// The promise: each ribbon's end points sit exactly on the top and bottom of its block's rows on
// that side, in both panes, after either pane scrolls, and with wrapped (taller) rows.
//
// A tiny model of what the browser reports. A pane starts at `paneTop` on screen, has `padding`
// above its first row, and each row sits `contentTop` px into the content. getBoundingClientRect
// then gives paneTop + padding + contentTop - scrollTop. The ribbon surface shares the pane's top.
type ModelPane = { paneTop: number; padding: number; scrollTop: number }
type ModelRow = { contentTop: number; height: number }

const PANE_TOP = 163.5
const PANE_PADDING = 4
const ROW = 20.4

function screenSpanOf(row: ModelRow, pane: ModelPane): ScreenSpan {
  const top = pane.paneTop + pane.padding + row.contentTop - pane.scrollTop

  return { top, bottom: top + row.height }
}

function frameOf(pane: ModelPane): PaneFrame {
  return { surfaceTop: pane.paneTop, scrollTop: pane.scrollTop }
}

// Measure a block once at `measuredAt`, the way SplitDiffView does after a render.
function measureBlock(
  left: ModelRow,
  right: ModelRow,
  leftPane: ModelPane,
  rightPane: ModelPane
): BlockEdges {
  const leftSpan = toContentSpan(screenSpanOf(left, leftPane), frameOf(leftPane))
  const rightSpan = toContentSpan(screenSpanOf(right, rightPane), frameOf(rightPane))

  return {
    leftTop: leftSpan.top,
    leftBottom: leftSpan.bottom,
    rightTop: rightSpan.top,
    rightBottom: rightSpan.bottom,
  }
}

// Where the rows really are on the ribbon surface at the current scroll: the expected ribbon ends.
function rowEdgesOnSurface(
  left: ModelRow,
  right: ModelRow,
  leftPane: ModelPane,
  rightPane: ModelPane
): BlockEdges {
  const leftSpan = screenSpanOf(left, leftPane)
  const rightSpan = screenSpanOf(right, rightPane)

  return {
    leftTop: leftSpan.top - leftPane.paneTop,
    leftBottom: leftSpan.bottom - leftPane.paneTop,
    rightTop: rightSpan.top - rightPane.paneTop,
    rightBottom: rightSpan.bottom - rightPane.paneTop,
  }
}

// Fractional rows (20.4px) leave float noise in the last digits, so both sides are compared at a
// thousandth of a pixel, far below anything a screen can show.
function toThousandths(edges: BlockEdges): BlockEdges {
  const round = (value: number): number => Math.round(value * 1000) / 1000

  return {
    leftTop: round(edges.leftTop),
    leftBottom: round(edges.leftBottom),
    rightTop: round(edges.rightTop),
    rightBottom: round(edges.rightBottom),
  }
}

describe("toContentSpan — each ribbon ends exactly on its block's rows", () => {
  // Base line 487 (one row) became head line 487 (one row), one inserted line further down.
  const leftRow: ModelRow = { contentTop: 486 * ROW, height: ROW }
  const rightRow: ModelRow = { contentTop: 487 * ROW, height: ROW }

  it("meets both rows at the scroll it was measured at, pane padding included", () => {
    // Arrange
    const leftPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9600 }
    const rightPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9620 }
    const edges = measureBlock(leftRow, rightRow, leftPane, rightPane)

    // Act
    const drawn = edgesInViewport(edges, leftPane.scrollTop, rightPane.scrollTop)

    // Assert
    const expected = rowEdgesOnSurface(leftRow, rightRow, leftPane, rightPane)
    expect(toThousandths(drawn)).toEqual(toThousandths(expected))
  })

  it("still meets both rows after the LEFT pane scrolls", () => {
    // Arrange
    const leftPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9600 }
    const rightPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9620 }
    const edges = measureBlock(leftRow, rightRow, leftPane, rightPane)
    const scrolledLeft: ModelPane = { ...leftPane, scrollTop: 9587.5 }

    // Act
    const drawn = edgesInViewport(edges, scrolledLeft.scrollTop, rightPane.scrollTop)

    // Assert
    const expected = rowEdgesOnSurface(leftRow, rightRow, scrolledLeft, rightPane)
    expect(toThousandths(drawn)).toEqual(toThousandths(expected))
  })

  it("still meets both rows after the RIGHT pane scrolls", () => {
    // Arrange
    const leftPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9600 }
    const rightPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9620 }
    const edges = measureBlock(leftRow, rightRow, leftPane, rightPane)
    const scrolledRight: ModelPane = { ...rightPane, scrollTop: 9661.25 }

    // Act
    const drawn = edgesInViewport(edges, leftPane.scrollTop, scrolledRight.scrollTop)

    // Assert
    const expected = rowEdgesOnSurface(leftRow, rightRow, leftPane, scrolledRight)
    expect(toThousandths(drawn)).toEqual(toThousandths(expected))
  })

  it("meets a wrapped row's full height, not one line of it", () => {
    // Arrange — wrap on: the head line wraps onto three visual lines.
    const wrappedRightRow: ModelRow = { contentTop: 487 * ROW, height: 3 * ROW }
    const leftPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9600 }
    const rightPane: ModelPane = { paneTop: PANE_TOP, padding: PANE_PADDING, scrollTop: 9620 }
    const edges = measureBlock(leftRow, wrappedRightRow, leftPane, rightPane)

    // Act
    const drawn = edgesInViewport(edges, leftPane.scrollTop, rightPane.scrollTop)

    // Assert
    const expected = rowEdgesOnSurface(leftRow, wrappedRightRow, leftPane, rightPane)
    expect(toThousandths(drawn)).toEqual(toThousandths(expected))
  })
})
