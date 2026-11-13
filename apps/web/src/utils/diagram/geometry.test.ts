import { describe, expect, it } from "vitest"

import { type LayoutDirection, nextLayoutDirection } from "./layoutDirection"
import { roundedOrthogonalPath } from "./orthogonalPath"
import { layoutSequence } from "./sequenceLayout"
import { estimateTextWidth, wrapText } from "./textMetrics"

describe("wrapText fits a name into at most two lines", () => {
  it("wraps by words and cuts the overflow with an ellipsis", () => {
    // Arrange
    const text = "Notification preferences synchronisation service worker"
    const maxWidth = 100
    const fontSize = 12

    // Act
    const wrapped = wrapText(text, maxWidth, fontSize, "sans", 2)

    // Assert
    const widths = wrapped.lines.map((line) => estimateTextWidth(line, fontSize, "sans"))
    expect({
      lineCount: wrapped.lines.length,
      truncated: wrapped.truncated,
      endsWithEllipsis: wrapped.lines[1]?.endsWith("…"),
      allFit: widths.every((width) => width <= maxWidth),
    }).toEqual({ lineCount: 2, truncated: true, endsWithEllipsis: true, allFit: true })
  })
})

describe("roundedOrthogonalPath rounds every elbow", () => {
  it("draws straight runs and a quadratic corner of the given radius", () => {
    // Arrange
    const points = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
    ]

    // Act
    const path = roundedOrthogonalPath(points, 8)

    // Assert
    const expected = "M 0 0 L 32 0 Q 40 0 40 8 L 40 30"
    expect(path).toBe(expected)
  })
})

describe("nextLayoutDirection switches at 720 px without flapping", () => {
  it("needs to pass the line by 16 px before it flips either way", () => {
    // Arrange
    const steps: Array<[LayoutDirection | null, number]> = [
      [null, 719],
      ["down", 730],
      ["down", 736],
      ["right", 710],
      ["right", 703],
    ]

    // Act
    const directions = steps.map(([current, width]) => nextLayoutDirection(current, width))

    // Assert
    expect(directions).toEqual(["down", "down", "right", "right", "down"])
  })
})

describe("layoutSequence puts messages in order between their columns", () => {
  it("spaces columns so a long label fits and draws a self-message as a loop", () => {
    // Arrange
    const columns = [{ headerWidth: 96 }, { headerWidth: 96 }]
    const rows = [
      { from: 0, to: 1, labelWidth: 300 },
      { from: 1, to: 1, labelWidth: 60 },
    ]

    // Act
    const layout = layoutSequence(columns, rows)

    // Assert
    const [first, second] = layout.rows
    const columnDistance = (layout.columns[1]?.center ?? 0) - (layout.columns[0]?.center ?? 0)
    expect({
      labelFits: columnDistance >= 300,
      ordered: (first?.y ?? 0) < (second?.y ?? 0),
      secondIsSelf: second?.isSelf,
      widthCoversSelfLabel: layout.width >= (second?.label.x ?? 0) + 60,
    }).toEqual({ labelFits: true, ordered: true, secondIsSelf: true, widthCoversSelfLabel: true })
  })
})
