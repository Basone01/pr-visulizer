import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { type ReactNode, useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

const deferredPatch = vi.hoisted(() => ({ resolve: null as ((patch: string) => void) | null }))

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: () => new Promise<string>((resolve) => (deferredPatch.resolve = resolve)),
  }

  return { getAppStorage: () => store, getPrClient: () => client }
})

vi.mock("@/hooks/useLineTokenizer", () => ({ useLineTokenizer: () => null }))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }
const file: ChangedFile = {
  path: "src/auth.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  language: null,
}

function DiffPaneHarness() {
  const nav = usePeekNavigation("")
  const { jumpTo } = nav

  useEffect(() => jumpTo({ path: file.path, line: 42 }), [jumpTo])

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={file}
      symbols={[]}
      anchorIndex={buildAnchorIndex([], [])}
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
      commitRange={NO_COMMIT_RANGE}
    />
  )
}

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

afterEach(() => {
  vi.useRealTimers()
  deferredPatch.resolve = null
})

describe("DiffPane cited-file navigation", () => {
  it("waits_for_a_cold_diff_then_scrolls_and_flashes_the_cited_line", async () => {
    // Arrange
    vi.useFakeTimers()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    renderWithQuery(<DiffPaneHarness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200)
    })

    // Act
    await act(async () => {
      deferredPatch.resolve?.("@@ -42,1 +42,1 @@\n-old guard\n+new guard")
      await vi.advanceTimersByTimeAsync(0)
    })

    // Assert
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
    expect(document.querySelector("[data-flash]")).toBeInTheDocument()
  })
})
