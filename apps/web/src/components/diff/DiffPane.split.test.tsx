import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_DIFF_VIEW_SETTINGS } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { getAppStorage } from "@/service/clientFactory"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// The side-by-side view toggle (§10), JetBrains style. A mixed hunk — one context line, then 2
// removed against 1 added — proves both halves of the pairing: the similar pair is one MODIFIED
// block (removed in the base pane, added in the head pane) and the leftover removal is a DELETED
// block whose head side is only an insertion-point marker. Each block gets one ribbon.

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
      commitRange={NO_COMMIT_RANGE}
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

// The pane a line was rendered into, and the change block its row belongs to.
function placementOf(text: string, paneName: "Base version" | "Head version"): string | null {
  const pane = screen.getByRole("region", { name: paneName })
  const row = within(pane).getByText(text).closest("[data-row]")
  if (!row) throw new Error(`"${text}" is not inside a split row — the split view did not render`)

  return row.getAttribute("data-block")
}

describe("DiffPane side-by-side toggle", () => {
  // The mocked storage lives for the whole module, and the toggle persists — so each test
  // re-arms the defaults rather than inheriting the previous one's split mode.
  beforeEach(async () => {
    await getAppStorage().set("diffViewSettings", JSON.stringify(DEFAULT_DIFF_VIEW_SETTINGS))
  })

  it("joins each removed block to the head block it became, base left and head right", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = renderWithQuery()
    await screen.findByText("const added = 4")
    // Inline is the default: there are no panes until the toggle flips.
    expect(screen.queryByRole("region", { name: "Base version" })).toBeNull()
    const expectedRibbonCount = 2

    // Act
    await user.click(screen.getByRole("button", { name: "Side-by-side view" }))

    // Assert — the similar pair is one modified block, split across the two panes.
    expect(placementOf("const removedFirst = 2", "Base version")).toBe("modified")
    expect(placementOf("const added = 4", "Head version")).toBe("modified")

    // The second removal has no counterpart: a deleted block, marked at its point in the head.
    expect(placementOf("const removedSecond = 3", "Base version")).toBe("deleted")
    const headPane = screen.getByRole("region", { name: "Head version" })
    expect(headPane.querySelector('[data-gap][data-block="deleted"]')).not.toBeNull()

    // One ribbon per block joins the two sides.
    expect(container.querySelectorAll("svg path[data-block]")).toHaveLength(expectedRibbonCount)
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
    const headPane = screen.getByRole("region", { name: "Head version" })
    expect(within(headPane).getByText("const added = 4")).toBeInTheDocument()
  })
})
