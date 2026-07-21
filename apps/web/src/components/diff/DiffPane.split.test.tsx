import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_DIFF_VIEW_SETTINGS } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { getAppStorage } from "@/service/clientFactory"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"

// The side-by-side view toggle (§10). A mixed hunk — one context line, then 2 removed against 1
// added — proves both halves of the pairing: the balanced pair shares a row (removed LEFT, added
// RIGHT) and the unpaired removal keeps its row with an empty head cell.

const PATCH = [
  "@@ -1,3 +1,2 @@",
  " const kept = 1",
  "-const removedFirst = 2",
  "-const removedSecond = 3",
  "+const added = 4",
].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = { getPatch: async () => PATCH }

  return { getPrClient: () => client, getAppStorage: () => store }
})

vi.mock("@/hooks/useLineTokenizer", () => ({ useLineTokenizer: () => null }))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const modifiedFile: ChangedFile = {
  path: "src/x.ts",
  status: "modified",
  additions: 1,
  deletions: 2,
  language: null,
}

function DiffPaneHarness() {
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([])
  const nav = usePeekNavigation("")
  const anchorIndex = buildAnchorIndex([], [])

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={modifiedFile}
      symbols={[]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={reviewedFiles.includes(modifiedFile.path)}
      onToggleReviewed={(path) => setReviewedFiles((current) => [...current, path])}
      suggestedNextPath="src/next.ts"
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
      <DiffPaneHarness />
    </QueryClientProvider>
  )
}

// The cell a line was rendered into, and where that cell sits in its row — the assertion that
// actually proves "removed on the left, added on the right".
function cellOf(text: string): { columnIndex: number; row: HTMLTableRowElement } {
  const cell = screen.getByText(text).closest("td")
  if (!cell) throw new Error(`"${text}" is not inside a table cell — the split view did not render`)

  const row = cell.closest("tr") as HTMLTableRowElement

  return { columnIndex: [...row.cells].indexOf(cell as HTMLTableCellElement), row }
}

describe("DiffPane side-by-side toggle", () => {
  // The mocked storage lives for the whole module, and the toggle persists — so each test
  // re-arms the defaults rather than inheriting the previous one's split mode.
  beforeEach(async () => {
    await getAppStorage().set("diffViewSettings", JSON.stringify(DEFAULT_DIFF_VIEW_SETTINGS))
  })

  it("pairs a removed line with its replacement on one row — removed left, added right", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await screen.findByText("const added = 4")
    // Inline is the default: nothing is in a table until the toggle flips.
    expect(screen.getByText("const added = 4").closest("td")).toBeNull()
    const baseColumn = 0
    const headColumn = 1

    // Act
    await user.click(screen.getByRole("button", { name: "Side-by-side view" }))

    // Assert — both sides of the balanced pair sit in the same row, on opposite columns.
    const removed = cellOf("const removedFirst = 2")
    const added = cellOf("const added = 4")
    expect(removed.columnIndex).toBe(baseColumn)
    expect(added.columnIndex).toBe(headColumn)
    expect(removed.row).toBe(added.row)

    // The second removal has no counterpart — it keeps the base column and an empty head cell.
    const unpaired = cellOf("const removedSecond = 3")
    expect(unpaired.columnIndex).toBe(baseColumn)
    expect(unpaired.row).not.toBe(added.row)
    expect(unpaired.row.cells[headColumn]).toBeEmptyDOMElement()
  })

  it("shows a context line on both sides, with the base number left and the head number right", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await screen.findByText("const kept = 1")
    const expectedHeadLine = "1"

    // Act
    await user.click(screen.getByRole("button", { name: "Side-by-side view" }))

    // Assert — one context line, rendered into both columns of its row.
    const contextCells = screen.getAllByText("const kept = 1")
    expect(contextCells).toHaveLength(2)
    // Only the head (right) column keeps the commentable gutter button (§11).
    expect(
      screen.getAllByRole("button", { name: `Comment on line ${expectedHeadLine}` })
    ).toHaveLength(1)
  })

  it("keeps mark-viewed and the next button working in split mode", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await screen.findByText("const added = 4")
    await user.click(screen.getByRole("button", { name: "Side-by-side view" }))
    const expectedNextTitle = "next: next.ts (⌥2)"

    // Act
    await user.click(screen.getByRole("button", { name: "Mark viewed" }))

    // Assert — the checkmark flipped and the diff is still in split mode behind it.
    const viewedToggle = screen.getByRole("button", { name: "Mark viewed" })
    expect(viewedToggle).toHaveAttribute("aria-pressed", "true")
    expect(viewedToggle).toHaveAttribute("title", "Mark not viewed (⌥1)")
    expect(screen.getByLabelText("Open next suggested file")).toHaveAttribute(
      "title",
      expectedNextTitle
    )
    expect(screen.getByText("const added = 4").closest("td")).not.toBeNull()
  })
})
