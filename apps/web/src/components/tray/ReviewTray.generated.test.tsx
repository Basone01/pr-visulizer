import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import type { PrView, TrayRow } from "@/entity/viewModels"

import { ReviewTray } from "./ReviewTray"
import { IDLE_SUBMIT_PROPS } from "./reviewTrayTestProps"

// Files treated as generated do not count toward completion, but the label comes from names
// and shapes the PR author controls. So the submit dialog names every one the reviewer has not
// viewed (CONTRACT §11.2, G2). No new gate.

function generatedRow(path: string, reviewed: boolean): TrayRow {
  return {
    path,
    order: null,
    skipReason: "generated",
    generatedEvidence: "file-name",
    diffOmitted: null,
    status: "modified",
    churn: 2,
    reviewed,
    readiness: null,
    isNext: false,
    blastRadius: null,
    draftCount: 0,
  }
}

function viewWith(trayRows: TrayRow[]): PrView {
  return {
    trayRows,
    fileNodes: [],
    ghostNodes: [],
    suggestedPath: null,
    reviewedCount: 6,
    totalCount: 6,
    allReviewed: true,
    generatedCount: trayRows.length,
    factsByPath: null,
  }
}

async function openSubmitDialog(view: PrView) {
  render(
    <ReviewTray
      view={view}
      chosenVerdict="approve"
      approveDisabled={false}
      onToggleReviewed={() => {}}
      onOpenFile={() => {}}
      activePath=""
      queueMode="foundations"
      onChooseQueueMode={() => {}}
      onHide={() => {}}
      onChooseVerdict={() => {}}
      onSubmit={() => {}}
      {...IDLE_SUBMIT_PROPS}
      commentCount={0}
    />
  )
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }))
  return within(screen.getByRole("dialog", { name: "Confirm review submission" }))
}

describe("the submit dialog and files treated as generated", () => {
  it("names each generated file not marked viewed, and leaves out the viewed ones", async () => {
    // Arrange
    const unviewedPath = "dist/app.min.js"
    const viewedPath = "assets/build/app.css.map"
    const view = viewWith([generatedRow(unviewedPath, false), generatedRow(viewedPath, true)])

    // Act
    const dialog = await openSubmitDialog(view)

    // Assert
    const expected = { count: true, unviewedListed: true, viewedListed: false }
    expect({
      count: dialog.queryByText(/1 file\(s\) treated as generated were not marked viewed/) !== null,
      unviewedListed: dialog.queryByText(unviewedPath) !== null,
      viewedListed: dialog.queryByText(viewedPath) !== null,
    }).toEqual(expected)
  })

  it("says nothing about generated files when there are none, or all of them are viewed", async () => {
    // Arrange
    const allViewed = viewWith([generatedRow("dist/app.min.js", true)])

    // Act
    const dialog = await openSubmitDialog(allViewed)

    // Assert
    expect(dialog.queryByText(/treated as generated/)).toBeNull()
  })

  it("lists the first 10 and shows the rest on request", async () => {
    // Arrange
    const generatedCount = 14
    const rows = Array.from({ length: generatedCount }, (_, index) =>
      generatedRow(`dist/chunk${String(index).padStart(2, "0")}.min.js`, false)
    )
    const dialog = await openSubmitDialog(viewWith(rows))
    const listedBefore = dialog.getAllByRole("listitem").length

    // Act
    await userEvent.click(dialog.getByRole("button", { name: `Show all ${generatedCount}` }))

    // Assert
    const expected = { listedBefore: 10, listedAfter: generatedCount }
    expect({ listedBefore, listedAfter: dialog.getAllByRole("listitem").length }).toEqual(expected)
  })
})
