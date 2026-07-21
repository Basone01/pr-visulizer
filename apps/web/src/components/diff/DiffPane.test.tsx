import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"

// A patch whose one change is indentation-only: base "  changed = 2" vs head "    changed = 2".
// With hide-WS off it shows a del row and an add row; on, the pair collapses to one context line.
const WHITESPACE_ONLY_PATCH = [
  "@@ -1,3 +1,3 @@",
  " const a = 1",
  "-  changed = 2",
  "+    changed = 2",
  " const b = 3",
].join("\n")

// The diff pane resolves the patch through getPrClient().getPatch and reads its view settings
// through getAppStorage — both mocked so the render exercises the real parse + transform without
// a BFF. A single in-memory store instance is returned so a toggle sticks across re-renders.
vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = { getPatch: async () => WHITESPACE_ONLY_PATCH }

  return {
    getPrClient: () => client,
    getAppStorage: () => store,
  }
})

// Keep the async shiki tokenizer out of the render — plain-text spans keep the line text in one
// node so it is queryable, and the test never waits on a lazy grammar chunk.
vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }
const file: ChangedFile = {
  path: "src/x.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  language: null,
}

function DiffPaneHarness() {
  const nav = usePeekNavigation("")
  const anchorIndex = buildAnchorIndex([], [])

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={file}
      symbols={[]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={false}
      onToggleReviewed={() => {}}
      suggestedNextPath={null}
      onOpenFile={() => {}}
      onHide={() => {}}
      drafts={[]}
      onAddDraft={() => {}}
      onUpdateDraft={() => {}}
      onDeleteDraft={() => {}}
    />
  )
}

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe("DiffPane hide-whitespace toggle", () => {
  it("collapses the whitespace-only del/add pair and shows the wsOnly marker", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness />)
    // Both sides of the indentation-only change render before toggling — one del, one add.
    const changedLinesBeforeToggle = await screen.findAllByText("changed = 2")
    expect(changedLinesBeforeToggle).toHaveLength(2)
    expect(screen.queryByTitle("whitespace-only change hidden")).toBeNull()

    // Act
    await user.click(screen.getByRole("button", { name: "Hide whitespace-only changes" }))

    // Assert
    const changedLinesAfterToggle = screen.getAllByText("changed = 2")
    expect(changedLinesAfterToggle).toHaveLength(1)
    expect(screen.getByTitle("whitespace-only change hidden")).toBeInTheDocument()
  })
})
