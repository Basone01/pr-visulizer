import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"

const PATCH = ["@@ -0,0 +1,4 @@", "+const a = 1", "+const b = 2", "+const c = 3", "+const d = 4"].join(
  "\n"
)

const addCommentNow = vi.fn(async () => {})

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  return {
    getPrClient: () => ({
      getPatch: async () => PATCH,
      getFileAtHead: async () => null,
      addCommentNow: (...args: unknown[]) => addCommentNow(...(args as [])),
    }),
    getAppStorage: () => store,
  }
})

vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const addedFile: ChangedFile = {
  path: "src/range.ts",
  status: "added",
  additions: 4,
  deletions: 0,
  language: null,
}

function Harness({ onAddDraft }: { onAddDraft: (draft: unknown) => void }) {
  const nav = usePeekNavigation("src/range.ts", 15)
  return (
    <DiffPane
      target={target}
      file={addedFile}
      symbols={[]}
      anchorIndex={buildAnchorIndex([], [])}
      nav={nav}
      reviewed={false}
      onToggleReviewed={() => {}}
      suggestedNextPath={null}
      changedPaths={new Set([addedFile.path])}
      onOpenFile={() => {}}
      onHide={() => {}}
      drafts={[]}
      onAddDraft={onAddDraft}
      onUpdateDraft={() => {}}
      onDeleteDraft={() => {}}
    />
  )
}

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("DiffPane range selection", () => {
  it("drag across gutter rows selects a range and the saved draft carries startLine", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")
    const endGutter = await screen.findByLabelText("Comment on line 4")

    // Act — GitHub-style drag: mousedown on line 2, drag over line 4, release, then save.
    fireEvent.mouseDown(startGutter)
    fireEvent.mouseEnter(endGutter)
    fireEvent.mouseUp(endGutter)
    expect(await screen.findByText("Comment on lines 2–4")).toBeInTheDocument()
    await userEvent.type(screen.getByRole("textbox"), "tighten this loop")
    await userEvent.click(screen.getByRole("button", { name: "Add" }))

    // Assert — the draft anchors at the range end and carries GitHub's start_line.
    const expectedDraft = {
      path: "src/range.ts",
      line: 4,
      startLine: 2,
      side: "RIGHT",
      body: "tighten this loop",
    }
    expect(onAddDraft).toHaveBeenCalledWith(expectedDraft)
  })

  it("Comment now publishes the range immediately through the client, not as a draft", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")
    const endGutter = await screen.findByLabelText("Comment on line 4")
    fireEvent.mouseDown(startGutter)
    fireEvent.mouseEnter(endGutter)
    fireEvent.mouseUp(endGutter)
    await userEvent.type(screen.getByRole("textbox"), "ship it now")

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Comment now" }))

    // Assert — the client publishes the ranged comment; no draft is added.
    const expectedComment = {
      path: "src/range.ts",
      line: 4,
      startLine: 2,
      side: "RIGHT",
      body: "ship it now",
    }
    expect(addCommentNow).toHaveBeenCalledWith(target, expectedComment)
    expect(onAddDraft).not.toHaveBeenCalled()
  })
})
