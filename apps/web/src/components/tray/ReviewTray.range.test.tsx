import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { PrView, TrayRow } from "@/entity/viewModels"

import { ReviewTray } from "./ReviewTray"
import { IDLE_SUBMIT_PROPS } from "./reviewTrayTestProps"

// Tray behaviour while a commit range is selected in the diff pane (§10). The range FILTERS the
// queue to the files those commits touched, without re-ranking it: the surviving rows keep their
// whole-PR order, and the reviewed progress stays whole-PR because GitHub's "Viewed" state is.

const FIRST_IN_RANGE_PATH = "src/config/limits.ts"
const OUT_OF_RANGE_PATH = "src/api/routes/login.ts"
const LAST_IN_RANGE_PATH = "src/lib/rateLimiter.ts"

function trayRow(path: string, order: number): TrayRow {
  return {
    path,
    order,
    skipReason: null,
    diffOmitted: null,
    status: "modified",
    churn: 12,
    reviewed: false,
    readiness: 1,
    isNext: false,
    blastRadius: null,
    draftCount: 0,
  }
}

// Three ranked files, with the out-of-range one in the MIDDLE — so a filtered list that kept its
// ranking order is distinguishable from one that merely dropped a trailing row.
function threeFileView(): PrView {
  return {
    trayRows: [
      trayRow(FIRST_IN_RANGE_PATH, 1),
      trayRow(OUT_OF_RANGE_PATH, 2),
      trayRow(LAST_IN_RANGE_PATH, 3),
    ],
    fileNodes: [],
    ghostNodes: [],
    suggestedPath: null,
    reviewedCount: 1,
    totalCount: 3,
    allReviewed: false,
    generatedCount: 0,
    factsByPath: null,
  }
}

function renderTray(props: {
  rangeTouchedPaths: Set<string> | null
  onToggleReviewed?: () => void
  onOpenFile?: () => void
}) {
  return render(
    <ReviewTray
      {...IDLE_SUBMIT_PROPS}
      view={threeFileView()}
      chosenVerdict={null}
      approveDisabled={false}
      onToggleReviewed={props.onToggleReviewed ?? (() => {})}
      onOpenFile={props.onOpenFile ?? (() => {})}
      activePath=""
      queueMode="foundations"
      onChooseQueueMode={() => {}}
      onHide={() => {}}
      onChooseVerdict={() => {}}
      onSubmit={() => {}}
      rangeTouchedPaths={props.rangeTouchedPaths}
    />
  )
}

// The listed paths, top to bottom — the tray's own rendered order, not the view model's.
function listedPaths(): string[] {
  return screen
    .getAllByRole("checkbox")
    .map((checkbox) => checkbox.getAttribute("aria-label")?.replace(/^Mark | reviewed$/g, "") ?? "")
}

describe("ReviewTray — commit range active", () => {
  it("lists ONLY the files the range touched, in whole-PR ranking order", () => {
    // Arrange — the untouched file sits between the two touched ones.
    const rangeTouchedPaths = new Set([FIRST_IN_RANGE_PATH, LAST_IN_RANGE_PATH])

    // Act
    renderTray({ rangeTouchedPaths })

    // Assert
    const expected = [FIRST_IN_RANGE_PATH, LAST_IN_RANGE_PATH]
    expect(listedPaths()).toEqual(expected)
  })

  it("says how many of the PR's files the range is showing, so hidden rows aren't a surprise", () => {
    // Arrange
    const rangeTouchedPaths = new Set([FIRST_IN_RANGE_PATH, LAST_IN_RANGE_PATH])

    // Act
    renderTray({ rangeTouchedPaths })

    // Assert
    const expected = "2 of 3"
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it("keeps the reviewed progress whole-PR — the range narrows the list, not the review", () => {
    // Arrange
    const rangeTouchedPaths = new Set([FIRST_IN_RANGE_PATH])

    // Act
    renderTray({ rangeTouchedPaths })

    // Assert — 1 of 3 files reviewed across the PR, even with one row listed.
    const expected = "1/3"
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it("shows a quiet empty message when the range touches nothing in the queue", () => {
    // Arrange — possible via a rename: the range lists the file under a name the queue doesn't.
    const rangeTouchedPaths = new Set(["src/lib/oldRateLimiterName.ts"])

    // Act
    renderTray({ rangeTouchedPaths })

    // Assert — an explanation, not a blank panel.
    const expected = { rowCount: 0, message: "No queued files in the selected commits." }
    expect({
      rowCount: screen.queryAllByRole("checkbox").length,
      message: screen.getByText("No queued files in the selected commits.").textContent,
    }).toEqual(expected)
  })

  it("lists every file, with no count line, when no range is selected", () => {
    // Arrange
    const noRange = null

    // Act
    renderTray({ rangeTouchedPaths: noRange })

    // Assert
    const expected = {
      paths: [FIRST_IN_RANGE_PATH, OUT_OF_RANGE_PATH, LAST_IN_RANGE_PATH],
      countLine: null,
    }
    expect({
      paths: listedPaths(),
      countLine: screen.queryByText(/files in the selected commits/),
    }).toEqual(expected)
  })

  it("keeps an in-range row openable and tickable — viewed state is still whole-PR", async () => {
    // Arrange
    const user = userEvent.setup()
    const onToggleReviewed = vi.fn()
    const onOpenFile = vi.fn()
    const rangeTouchedPaths = new Set([FIRST_IN_RANGE_PATH])
    renderTray({ rangeTouchedPaths, onToggleReviewed, onOpenFile })

    // Act
    const checkbox = screen.getByLabelText(`Mark ${FIRST_IN_RANGE_PATH} reviewed`)
    await user.click(checkbox)
    await user.click(screen.getByText(FIRST_IN_RANGE_PATH))

    // Assert
    const expected = { disabled: false, toggleCalls: 1, openCalls: 1 }
    expect({
      disabled: (checkbox as HTMLInputElement).disabled,
      toggleCalls: onToggleReviewed.mock.calls.length,
      openCalls: onOpenFile.mock.calls.length,
    }).toEqual(expected)
  })
})
