import { describe, expect, it } from "vitest"

import {
  type BlockEdges,
  followerScrollTop,
  isBlockVisible,
  mapAcross,
  ribbonPath,
  scrollAnchors,
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
