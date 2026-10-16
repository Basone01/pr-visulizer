import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_DIFF_VIEW_SETTINGS } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { getAppStorage } from "@/service/clientFactory"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane, type DiffPaneSelectionContext } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// Multi-line comment ranges are picked with TWO CLICKS (§11): the first gutter click anchors
// and opens the composer on that line, a second plain click completes the range, and a click
// after that starts over. This replaced a click-and-drag that never survived the composer
// opening under the pointer and shifting the rows out from under the drag.

const PATCH = [
  "@@ -0,0 +1,4 @@",
  "+const a = 1",
  "+const b = 2",
  "+const c = 3",
  "+const d = 4",
].join("\n")

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

function Harness({
  onAddDraft,
  onSelectionChange,
}: {
  onAddDraft: (draft: unknown) => void
  onSelectionChange?: (selection: DiffPaneSelectionContext | null) => void
}) {
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
      onSelectionChange={onSelectionChange}
      commitRange={NO_COMMIT_RANGE}
    />
  )
}

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("DiffPane click-click range selection", () => {
  // The view-mode toggle persists in the mocked storage, so each test re-arms the defaults
  // rather than inheriting the previous one's split mode.
  beforeEach(async () => {
    await getAppStorage().set("diffViewSettings", JSON.stringify(DEFAULT_DIFF_VIEW_SETTINGS))
  })

  it("lifts the exact current head-side selection for a scoped AI chat", async () => {
    // Arrange
    const onSelectionChange = vi.fn()
    renderWithQuery(<Harness onAddDraft={() => {}} onSelectionChange={onSelectionChange} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")
    const endGutter = await screen.findByLabelText("Comment on line 4")

    // Act
    await userEvent.click(startGutter)
    await userEvent.click(endGutter)

    // Assert
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        path: "src/range.ts",
        side: "RIGHT",
        startLine: 2,
        endLine: 4,
      })
    )
  })

  it("reports_a_cleared_line_selection_to_its_host_as_null", async () => {
    // Arrange
    const onSelectionChange = vi.fn()
    renderWithQuery(<Harness onAddDraft={() => {}} onSelectionChange={onSelectionChange} />)
    await userEvent.click(await screen.findByLabelText("Comment on line 2"))
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ startLine: 2, endLine: 2 })
      )
    )

    // Act
    await userEvent.keyboard("{Escape}")

    // Assert
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith(null))
  })

  it("opens the composer on the first gutter click, still a single line", async () => {
    // Arrange — today's one-click-opens-a-composer behaviour must survive the range feature.
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")

    // Act
    await userEvent.click(startGutter)

    // Assert
    expect(await screen.findByText("Comment on line 2")).toBeInTheDocument()
  })

  it("completes the range on a second click and the saved draft carries startLine", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")
    const endGutter = await screen.findByLabelText("Comment on line 4")

    // Act
    await userEvent.click(startGutter)
    await userEvent.click(endGutter)
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

  it("completes the range upward when the second click is above the first", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 4")
    const endGutter = await screen.findByLabelText("Comment on line 2")

    // Act
    await userEvent.click(startGutter)
    await userEvent.click(endGutter)

    // Assert — the composer spans the normalized range regardless of click order.
    expect(await screen.findByText("Comment on lines 2–4")).toBeInTheDocument()
  })

  it("starts a fresh single-line selection on the click after a completed range", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const firstGutter = await screen.findByLabelText("Comment on line 1")
    const secondGutter = await screen.findByLabelText("Comment on line 2")
    const thirdGutter = await screen.findByLabelText("Comment on line 4")

    // Act
    await userEvent.click(firstGutter)
    await userEvent.click(secondGutter)
    await userEvent.click(thirdGutter)

    // Assert — line 4 anchors a new comment instead of stretching 1–2 into 1–4.
    expect(await screen.findByText("Comment on line 4")).toBeInTheDocument()
  })

  it("clears the selection on Escape", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")
    await userEvent.click(startGutter)
    expect(await screen.findByText("Comment on line 2")).toBeInTheDocument()

    // Act
    await userEvent.keyboard("{Escape}")

    // Assert
    expect(screen.queryByText("Comment on line 2")).not.toBeInTheDocument()
  })

  it("picks a range from the head column in side-by-side mode too", async () => {
    // Arrange — split mode renders the head lines in the RIGHT column; the gutter there is
    // the same commentable button, so the range machine has to work identically.
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    await userEvent.click(await screen.findByRole("button", { name: "Side-by-side view" }))
    const startGutter = await screen.findByLabelText("Comment on line 2")
    const endGutter = await screen.findByLabelText("Comment on line 4")

    // Act
    await userEvent.click(startGutter)
    await userEvent.click(endGutter)
    await userEvent.type(screen.getByRole("textbox"), "same range, split view")
    await userEvent.click(screen.getByRole("button", { name: "Add" }))

    // Assert
    const expectedDraft = {
      path: "src/range.ts",
      line: 4,
      startLine: 2,
      side: "RIGHT",
      body: "same range, split view",
    }
    expect(onAddDraft).toHaveBeenCalledWith(expectedDraft)
  })

  it("Comment now publishes the range immediately through the client, not as a draft", async () => {
    // Arrange
    const onAddDraft = vi.fn()
    renderWithQuery(<Harness onAddDraft={onAddDraft} />)
    const startGutter = await screen.findByLabelText("Comment on line 2")
    const endGutter = await screen.findByLabelText("Comment on line 4")
    await userEvent.click(startGutter)
    await userEvent.click(endGutter)
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
