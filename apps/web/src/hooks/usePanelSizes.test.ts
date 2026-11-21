import { describe, expect, it } from "vitest"

import {
  DEFAULT_PANEL_SIZES,
  MIN_CENTER_PANE,
  MIN_SIDE_PANE,
  type PanelSizes,
  fitSidePanesToWindow,
} from "./usePanelSizes"

// The graph and tray dividers in the review shell, 6px each.
const SHELL_DIVIDERS = 12

// Where the diff pane ends when it gets its minimum width: the side panes are fixed-width, so
// this is the furthest right the diff can be pushed.
function diffRightEdge(fitted: PanelSizes): number {
  return fitted.graph + SHELL_DIVIDERS / 2 + MIN_CENTER_PANE
}

describe("fitSidePanesToWindow", () => {
  it("diff panel fits the window at narrow widths", () => {
    // Arrange
    const savedSizes: PanelSizes = { ...DEFAULT_PANEL_SIZES, graph: 400, tray: 300 }
    const narrowWindowWidth = 700
    const mediumWindowWidth = 1000

    // Act
    const narrow = fitSidePanesToWindow(savedSizes, narrowWindowWidth)
    const medium = fitSidePanesToWindow(savedSizes, mediumWindowWidth)

    // Assert
    const expected = {
      diffFitsAt700: true,
      diffFitsAt1000: true,
      wholeRowFitsAt1000: true,
      sidePanesKeepTheirMinimum: true,
    }
    expect({
      diffFitsAt700: diffRightEdge(narrow) <= narrowWindowWidth,
      diffFitsAt1000: diffRightEdge(medium) <= mediumWindowWidth,
      wholeRowFitsAt1000:
        diffRightEdge(medium) + SHELL_DIVIDERS / 2 + medium.tray <= mediumWindowWidth,
      sidePanesKeepTheirMinimum: [narrow.graph, narrow.tray, medium.graph, medium.tray].every(
        (width) => width >= MIN_SIDE_PANE
      ),
    }).toEqual(expected)
  })

  it("keeps the saved side pane widths when the window has room for them", () => {
    // Arrange
    const savedSizes: PanelSizes = { ...DEFAULT_PANEL_SIZES, graph: 400, tray: 300 }
    const wideWindowWidth = 1800

    // Act
    const fitted = fitSidePanesToWindow(savedSizes, wideWindowWidth)

    // Assert
    const expected = savedSizes
    expect(fitted).toEqual(expected)
  })
})
