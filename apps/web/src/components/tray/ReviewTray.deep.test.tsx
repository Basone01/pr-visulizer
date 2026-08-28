import { type AnalysisResult, analysisResultSchema } from "@pr-visulizer/shared"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { derivePrView } from "@/utils/graph/deriveView"

import { pr42Analysis, pr42Paths } from "@/service/fixture/pr42"

import { ReviewTray } from "./ReviewTray"
import { IDLE_SUBMIT_PROPS } from "./reviewTrayTestProps"

// A deep AnalysisResult (docs/architecture.md §6): PR #42 plus an unchanged ghost caller, with
// blast radius 1 on the middleware it references. The tray shows the ⚠️ badge only where blast
// radius > 0, and the derived view carries the ghost with its used-symbol list.

const GHOST_PATH = "src/api/routes/admin.ts"
const WITH_RATE_LIMIT_ID = `${pr42Paths.withRateLimit}#withRateLimit`

const deepAnalysis: AnalysisResult = analysisResultSchema.parse({
  ...pr42Analysis,
  engine: "deep",
  ghosts: [
    {
      path: GHOST_PATH,
      usedChangedSymbols: [WITH_RATE_LIMIT_ID],
      usesChangedFiles: [pr42Paths.withRateLimit],
    },
  ],
  // Deep ranking carries blastRadius per changed file; only withRateLimit has an unchanged
  // dependent here, so it is the one row that shows the badge.
  ranking: pr42Analysis.ranking.map((ranked) =>
    ranked.path === pr42Paths.withRateLimit
      ? { ...ranked, blastRadius: 1 }
      : { ...ranked, blastRadius: 0 }
  ),
})

function renderDeepTray() {
  const view = derivePrView(deepAnalysis, [])
  render(
    <ReviewTray
      view={view}
      chosenVerdict={null}
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
    />
  )

  return view
}

describe("ReviewTray blast-radius badge (deep engine)", () => {
  it("shows ⚠️ only for the row with blast radius > 0", () => {
    // Arrange / Act
    renderDeepTray()

    // Assert
    expect(screen.getByText(/⚠️ 1/)).toBeInTheDocument()
    expect(screen.queryByText(/⚠️ 0/)).toBeNull()
  })

  it("derives the ghost with its used changed-symbol list and the file it reaches", () => {
    // Arrange
    const expectedGhost = {
      path: GHOST_PATH,
      fileName: "admin.ts",
      usedChangedSymbols: [WITH_RATE_LIMIT_ID],
      usesChangedFiles: [pr42Paths.withRateLimit],
    }

    // Act
    const view = renderDeepTray()

    // Assert
    expect(view.ghostNodes).toEqual([expectedGhost])
  })
})
