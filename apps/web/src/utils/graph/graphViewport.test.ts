import { describe, expect, it } from "vitest"

import { DEFAULT_GRAPH_ZOOM_POLICY } from "./graphViewport"

// These three numbers only work as a set: fitView clamps its result to [min, max], so an
// initialFitMax outside that range is silently ignored and the first frame is wrong. The tests
// pin the relationship, not the taste.
describe("DEFAULT_GRAPH_ZOOM_POLICY", () => {
  it("keeps the initial-fit ceiling inside the pane's own zoom range", () => {
    // Arrange
    const { min, max, initialFitMax } = DEFAULT_GRAPH_ZOOM_POLICY

    // Act
    const isInsideRange = initialFitMax >= min && initialFitMax <= max

    // Assert — outside the range, fitView clamps and the ceiling stops meaning anything.
    expect(isInsideRange).toBe(true)
  })

  it("keeps the zoom floor well below React Flow's default, so a big graph can be framed", () => {
    // Arrange — React Flow defaults minZoom to 0.5 (verified in @xyflow/react 12.11.1
    // getInitialState). Measured on the 120-file fixture, that floor pinned the viewport at
    // exactly scale(0.5) with 32 of 129 nodes rendered; framing it needs ~0.11.
    const reactFlowDefaultMinZoom = 0.5
    const zoomNeededByThe120FileFixture = 0.11

    // Act
    const { min } = DEFAULT_GRAPH_ZOOM_POLICY

    // Assert — raising this back toward the default re-breaks the initial frame on a big PR.
    expect(min).toBeLessThan(reactFlowDefaultMinZoom)
    expect(min).toBeLessThan(zoomNeededByThe120FileFixture)
  })

  it("pulls a focused file back to a legible zoom the overview fit cannot give", () => {
    // Arrange — the initial fit of a big PR lands near 0.11, far below anything readable.
    const { min, max, focusMinZoom } = DEFAULT_GRAPH_ZOOM_POLICY
    const zoomAfterFittingThe120FileFixture = 0.11

    // Act
    const isLegibleFloor = focusMinZoom > zoomAfterFittingThe120FileFixture

    // Assert — and the floor has to be reachable, or setCenter clamps it away.
    expect(isLegibleFloor).toBe(true)
    expect(focusMinZoom).toBeGreaterThanOrEqual(min)
    expect(focusMinZoom).toBeLessThanOrEqual(max)
  })
})
