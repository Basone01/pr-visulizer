import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { TrayRow as TrayRowVM } from "@/entity/viewModels"

import { TrayRow } from "./TrayRow"

function trayRow(overrides: Partial<TrayRowVM>): TrayRowVM {
  return {
    path: "src/app.ts",
    order: 1,
    skipReason: null,
    diffOmitted: null,
    status: "modified",
    churn: 4,
    reviewed: false,
    readiness: 1,
    isNext: false,
    blastRadius: null,
    draftCount: 0,
    ...overrides,
  }
}

function renderRow(row: TrayRowVM) {
  return render(<TrayRow row={row} active={false} onToggle={() => {}} onOpen={() => {}} />)
}

describe("a review-queue row", () => {
  it("shows generated instead of a readiness value, also once the file is viewed", () => {
    // Arrange
    const generatedViewed = trayRow({
      path: "assets/build/css/summary_css.css.map",
      order: null,
      skipReason: "generated",
      readiness: null,
      reviewed: true,
    })

    // Act
    renderRow(generatedViewed)

    // Assert
    const expected = { label: true, readinessChip: false }
    expect({
      label: screen.queryByText("generated") !== null,
      readinessChip: screen.queryByTestId("readiness-chip") !== null,
    }).toEqual(expected)
  })

  it("keeps a diff-omitted file's readiness and adds a note that its diff is too large", () => {
    // Arrange
    const routerRow = trayRow({ path: "src/server/router.ts", diffOmitted: "too-large" })

    // Act
    renderRow(routerRow)

    // Assert
    const expected = { note: true, readinessChip: true }
    expect({
      note: screen.queryByText("diff too large") !== null,
      readinessChip: screen.queryByTestId("readiness-chip") !== null,
    }).toEqual(expected)
  })
})
