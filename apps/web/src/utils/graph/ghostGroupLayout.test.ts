import { describe, expect, it } from "vitest"

import { GHOST_NODE_HEIGHT, NODE_HEIGHT, NODE_WIDTH } from "./elkLayout"
import { DEFAULT_GHOST_GROUP_SETTINGS, layoutGhostGroup } from "./ghostGroupLayout"

// The band exists so ghosts (context, never work — §6) stop interleaving with the changed files
// elk lays out. These pin the two things that guarantee that: it never overlaps the main graph,
// and it disappears entirely when there are no ghosts.
describe("layoutGhostGroup", () => {
  it("reserves no band at all when the PR has no ghosts (the fast engine)", () => {
    // Arrange — the fast engine returns an empty ghost list, which is the common case.
    const ghostPaths: string[] = []
    const mainBoxes = [{ x: 12, y: 12, width: NODE_WIDTH, height: NODE_HEIGHT }]

    // Act
    const layout = layoutGhostGroup(ghostPaths, mainBoxes)

    // Assert — null, so the caller renders no backdrop and the graph is byte-for-byte today's.
    const expected = null
    expect(layout).toBe(expected)
  })

  it("places the band below the main graph's lowest node, never overlapping it", () => {
    // Arrange — two changed nodes; the lower one ends at y = 300 + NODE_HEIGHT.
    const topBox = { x: 12, y: 12, width: NODE_WIDTH, height: NODE_HEIGHT }
    const bottomBox = { x: 12, y: 300, width: NODE_WIDTH, height: NODE_HEIGHT }
    const ghostPaths = ["src/app/consumer.ts"]

    // Act
    const layout = layoutGhostGroup(ghostPaths, [topBox, bottomBox])

    // Assert
    const expectedTop = bottomBox.y + bottomBox.height + DEFAULT_GHOST_GROUP_SETTINGS.gapAboveGroup
    expect(layout?.box.y).toBe(expectedTop)
    expect(layout?.box.x).toBe(topBox.x)
  })

  it("wraps the ghosts into a grid, packing each row across the band's inner width", () => {
    // Arrange — a main graph whose INNER width (less the band's own padding) holds exactly three
    // ghost columns.
    const { columnGap, padding, labelHeight, rowGap, gapAboveGroup } = DEFAULT_GHOST_GROUP_SETTINGS
    const mainWidth = NODE_WIDTH * 3 + columnGap * 2 + padding * 2
    const mainBoxes = [{ x: 0, y: 0, width: mainWidth, height: NODE_HEIGHT }]
    const ghostPaths = ["a.ts", "b.ts", "c.ts", "d.ts"]

    // Act
    const layout = layoutGhostGroup(ghostPaths, mainBoxes)

    // Assert — three across, so the fourth ghost starts a second row directly under the first.
    const expectedBandTop = NODE_HEIGHT + gapAboveGroup
    const expectedFirst = { x: padding, y: expectedBandTop + padding + labelHeight }
    expect(layout?.positions.get("a.ts")).toEqual(expectedFirst)
    expect(layout?.positions.get("c.ts")).toEqual({
      x: expectedFirst.x + 2 * (NODE_WIDTH + columnGap),
      y: expectedFirst.y,
    })
    expect(layout?.positions.get("d.ts")).toEqual({
      x: expectedFirst.x,
      y: expectedFirst.y + GHOST_NODE_HEIGHT + rowGap,
    })
  })

  it("sizes the box to hold every ghost it placed, plus its label row", () => {
    // Arrange — four ghosts over a three-column-wide main graph is two rows.
    const { columnGap, padding, labelHeight, rowGap } = DEFAULT_GHOST_GROUP_SETTINGS
    const mainWidth = NODE_WIDTH * 3 + columnGap * 2 + padding * 2
    const mainBoxes = [{ x: 0, y: 0, width: mainWidth, height: NODE_HEIGHT }]
    const ghostPaths = ["a.ts", "b.ts", "c.ts", "d.ts"]

    // Act
    const layout = layoutGhostGroup(ghostPaths, mainBoxes)

    // Assert — the band spans the main graph exactly, and reserves both ghost rows.
    const expectedRows = 2
    const expectedHeight =
      padding * 2 + labelHeight + expectedRows * GHOST_NODE_HEIGHT + (expectedRows - 1) * rowGap
    expect(layout?.box.width).toBe(mainWidth)
    expect(layout?.box.height).toBe(expectedHeight)
  })

  it("never packs more columns than there are ghosts, however wide the main graph is", () => {
    // Arrange — a very wide main graph but a single ghost.
    const mainWidth = 4000
    const mainBoxes = [{ x: 0, y: 0, width: mainWidth, height: NODE_HEIGHT }]
    const ghostPaths = ["only.ts"]

    // Act
    const layout = layoutGhostGroup(ghostPaths, mainBoxes)

    // Assert — one row of one, so the band stays one ghost tall rather than stretching that lone
    // node across 4000px. The box still spans the main graph, so it reads as its footer.
    const { padding, labelHeight } = DEFAULT_GHOST_GROUP_SETTINGS
    const expectedHeight = padding * 2 + labelHeight + GHOST_NODE_HEIGHT
    expect(layout?.box.width).toBe(mainWidth)
    expect(layout?.box.height).toBe(expectedHeight)
  })

  it("keeps the band no wider than the main graph when a full row exactly fits", () => {
    // Arrange — a regression guard: measuring columns against the OUTER width overflowed the
    // band past the graph it sits under by twice its padding.
    const { columnGap, padding } = DEFAULT_GHOST_GROUP_SETTINGS
    const mainWidth = NODE_WIDTH * 3 + columnGap * 2 + padding * 2
    const mainBoxes = [{ x: 0, y: 0, width: mainWidth, height: NODE_HEIGHT }]
    const ghostPaths = ["a.ts", "b.ts", "c.ts"]

    // Act
    const layout = layoutGhostGroup(ghostPaths, mainBoxes)

    // Assert
    const expectedWidth = mainWidth
    expect(layout?.box.width).toBe(expectedWidth)
  })

  it("honours overridden spacing settings over the defaults", () => {
    // Arrange — the controllable core: the band's spacing is a setting, not a constant.
    const gapAboveGroup = 500
    const mainBoxes = [{ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT }]
    const ghostPaths = ["a.ts"]

    // Act
    const layout = layoutGhostGroup(ghostPaths, mainBoxes, { gapAboveGroup })

    // Assert
    const expectedTop = NODE_HEIGHT + gapAboveGroup
    expect(layout?.box.y).toBe(expectedTop)
  })
})
