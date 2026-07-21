import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { PrView, TrayRow } from "@/entity/viewModels"

import { ReviewTray } from "./ReviewTray"
import { IDLE_SUBMIT_PROPS } from "./reviewTrayTestProps"

// Tray behaviour while a commit range is selected in the diff pane (§10). The range is a MARKER
// only: rows outside it are muted, but the queue keeps its whole-PR order and every row stays
// openable and tickable — review order and GitHub's "Viewed" checkboxes are whole-PR concepts.

const IN_RANGE_PATH = "src/lib/rateLimiter.ts"
const OUT_OF_RANGE_PATH = "src/api/routes/login.ts"

function trayRow(path: string, order: number): TrayRow {
  return {
    path,
    order,
    status: "modified",
    churn: 12,
    reviewed: false,
    readiness: 1,
    isNext: false,
    blastRadius: null,
    draftCount: 0,
  }
}

function twoFileView(): PrView {
  return {
    trayRows: [trayRow(IN_RANGE_PATH, 1), trayRow(OUT_OF_RANGE_PATH, 2)],
    fileNodes: [],
    ghostNodes: [],
    suggestedPath: null,
    reviewedCount: 0,
    totalCount: 2,
    allReviewed: false,
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
      view={twoFileView()}
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

describe("ReviewTray — commit range active", () => {
  it("marks only the rows the range does NOT touch", () => {
    // Arrange
    const rangeTouchedPaths = new Set([IN_RANGE_PATH])

    // Act
    renderTray({ rangeTouchedPaths })

    // Assert — the untouched row explains itself in its title; the touched one doesn't.
    const expected = {
      inRangeTitle: IN_RANGE_PATH,
      outOfRangeTitle: `${OUT_OF_RANGE_PATH} — not changed in the selected commits`,
    }
    expect({
      inRangeTitle: screen.getByText(IN_RANGE_PATH).getAttribute("title"),
      outOfRangeTitle: screen.getByText(OUT_OF_RANGE_PATH).getAttribute("title"),
    }).toEqual(expected)
  })

  it("marks nothing when no range is selected", () => {
    // Arrange
    const noRange = null

    // Act
    renderTray({ rangeTouchedPaths: noRange })

    // Assert — both rows keep their plain path title.
    const expected = { first: IN_RANGE_PATH, second: OUT_OF_RANGE_PATH }
    expect({
      first: screen.getByText(IN_RANGE_PATH).getAttribute("title"),
      second: screen.getByText(OUT_OF_RANGE_PATH).getAttribute("title"),
    }).toEqual(expected)
  })

  it("keeps 'mark viewed' enabled on an out-of-range row — viewed state is whole-PR", async () => {
    // Arrange
    const user = userEvent.setup()
    const onToggleReviewed = vi.fn()
    const rangeTouchedPaths = new Set([IN_RANGE_PATH])
    renderTray({ rangeTouchedPaths, onToggleReviewed })

    // Act
    const checkbox = screen.getByLabelText(`Mark ${OUT_OF_RANGE_PATH} reviewed`)
    await user.click(checkbox)

    // Assert
    const expected = { disabled: false, toggleCalls: 1 }
    expect({
      disabled: (checkbox as HTMLInputElement).disabled,
      toggleCalls: onToggleReviewed.mock.calls.length,
    }).toEqual(expected)
  })

  it("keeps an out-of-range row openable, and keeps the whole-PR queue order", async () => {
    // Arrange
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    const rangeTouchedPaths = new Set([IN_RANGE_PATH])
    renderTray({ rangeTouchedPaths, onOpenFile })

    // Act
    await user.click(screen.getByText(OUT_OF_RANGE_PATH))

    // Assert — both files still listed, in the same order, and the click opened the file.
    const expected = { openCalls: 1, rowCount: 2 }
    expect({
      openCalls: onOpenFile.mock.calls.length,
      rowCount: screen.getAllByRole("checkbox").length,
    }).toEqual(expected)
  })
})
