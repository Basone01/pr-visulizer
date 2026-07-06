import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ReadinessChip } from "./ReadinessChip"

// The readiness chip is the tray row's status cell (§8.2): a value while pending, the
// "next" marker on the suggestion, a check once reviewed.

describe("ReadinessChip", () => {
  it("shows the readiness value formatted to two decimals while pending", () => {
    // Arrange
    const readiness = 0.5
    const isNext = false
    const reviewed = false

    // Act
    render(<ReadinessChip readiness={readiness} isNext={isNext} reviewed={reviewed} />)

    // Assert
    expect(screen.getByTestId("readiness-chip")).toHaveTextContent("0.50")
  })

  it("marks the suggested-next row", () => {
    // Arrange
    const readiness = 1
    const isNext = true
    const reviewed = false

    // Act
    render(<ReadinessChip readiness={readiness} isNext={isNext} reviewed={reviewed} />)

    // Assert
    expect(screen.getByTestId("readiness-chip")).toHaveTextContent("👉 next")
  })

  it("shows a check once the file is reviewed", () => {
    // Arrange
    const readiness = 1
    const isNext = false
    const reviewed = true

    // Act
    render(<ReadinessChip readiness={readiness} isNext={isNext} reviewed={reviewed} />)

    // Assert
    expect(screen.getByTestId("readiness-chip")).toHaveTextContent("✓")
  })
})
