import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"
import { derivePrView } from "@/utils/graph/deriveView"

import type { PrTarget } from "@/entity/pr"

import { pr42Analysis, pr42Paths } from "@/service/fixture/pr42"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"

// The diff header's "open next" button follows the live suggestion (docs/architecture.md §8.2,
// task 1): with nothing reviewed it points at the first foundation (limits.ts); after that file
// is checked off, suggestNext advances and the button's target updates to http.ts.

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = { getPatch: async () => "" }

  return { getPrClient: () => client, getAppStorage: () => store }
})

vi.mock("@/hooks/useLineTokenizer", () => ({ useLineTokenizer: () => null }))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

// The reviewer is sitting on limits.ts — the first suggestion — so checking it viewed here
// moves the suggestion forward, exactly the "after a checkmark" case.
const limitsFile: ChangedFile = {
  path: pr42Paths.limits,
  status: "added",
  additions: 4,
  deletions: 0,
  language: null,
}

function NextButtonHarness() {
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([])
  const nav = usePeekNavigation("")
  const anchorIndex = buildAnchorIndex([], [])
  const view = derivePrView(pr42Analysis, reviewedFiles, [])

  return (
    <DiffPane
      target={target}
      file={limitsFile}
      symbols={[]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={reviewedFiles.includes(limitsFile.path)}
      onToggleReviewed={(path) => setReviewedFiles((current) => [...current, path])}
      suggestedNextPath={view.suggestedPath}
      onOpenFile={() => {}}
      onHide={() => {}}
      drafts={[]}
      onAddDraft={() => {}}
      onUpdateDraft={() => {}}
      onDeleteDraft={() => {}}
    />
  )
}

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <NextButtonHarness />
    </QueryClientProvider>
  )
}

describe("DiffPane next button follows the suggestion", () => {
  it("advances the target from limits.ts to http.ts after limits.ts is marked viewed", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    const nextButton = screen.getByLabelText("Open next suggested file")
    expect(nextButton).toHaveAttribute("title", "next: limits.ts (Ctrl+2)")

    // Act
    await user.click(screen.getByRole("button", { name: "Mark viewed" }))

    // Assert
    const expectedTitle = "next: http.ts (Ctrl+2)"
    expect(nextButton).toHaveAttribute("title", expectedTitle)
  })
})
