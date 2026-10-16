import type { ChangedFile, CommitRange, PrCommit, RangeDiff } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { useDiffCommitRange } from "@/hooks/useDiffCommitRange"
import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"

// The file history lens (§10) end to end in the pane: pick a change from the popover, then step
// with the chip's older/newer controls. The real commit-range hook runs, only the client is mocked.

const BASE_SHA = "base000000000000000000000000000000000000"
const CONFIG_SHA = "c0ffee1000000000000000000000000000000001"
const LIMITER_SHA = "c0ffee2000000000000000000000000000000002"
const LIMITER_PATH = "src/lib/rateLimiter.ts"

function commit(sha: string, parent: string, messageHeadline: string): PrCommit {
  return {
    sha,
    parents: [parent],
    messageHeadline,
    author: "mona",
    authoredAt: "2026-07-01T10:00:00Z",
  }
}

// Both PR commits touched the rate limiter, oldest-first.
const prCommits = [
  commit(CONFIG_SHA, BASE_SHA, "Add the limiter skeleton"),
  commit(LIMITER_SHA, CONFIG_SHA, "Make the limiter count requests"),
]

// Each commit's own change to the file, keyed by the commit the range ends at.
const patchByHeadSha: Record<string, string> = {
  [CONFIG_SHA]: "@@ -0,0 +1,1 @@\n+export const skeleton = 1",
  [LIMITER_SHA]: "@@ -1,1 +1,1 @@\n-export const skeleton = 1\n+export const counted = 2",
}

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: async () => "@@ -0,0 +1,1 @@\n+export const wholePr = 3",
    listCommits: async () => ({ commits: prCommits, truncated: false }),
    getFileHistory: async (_target: PrTarget, path: string) => ({
      path,
      commits: prCommits,
      truncated: false,
    }),
    getRangeDiff: async (_target: PrTarget, range: CommitRange): Promise<RangeDiff> => ({
      ...range,
      files: [
        {
          path: LIMITER_PATH,
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: patchByHeadSha[range.headSha] ?? null,
          previousPath: null,
        },
      ],
      truncated: false,
    }),
  }

  return { getPrClient: () => client, getAppStorage: () => store }
})

vi.mock("@/hooks/useLineTokenizer", () => ({ useLineTokenizer: () => null }))

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

const openFile: ChangedFile = {
  path: LIMITER_PATH,
  status: "added",
  additions: 1,
  deletions: 0,
  language: "typescript",
}

function DiffPaneHarness() {
  const nav = usePeekNavigation(LIMITER_PATH)
  const commitRange = useDiffCommitRange(target, BASE_SHA)

  return (
    <DiffPane
      changedPaths={new Set<string>([LIMITER_PATH])}
      target={target}
      file={openFile}
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
      commitRange={commitRange}
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

describe("DiffPane file history", () => {
  it("steps_through_the_files_changes_with_the_chip_controls", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await user.click(await screen.findByRole("button", { name: "File history" }))
    await user.click(await screen.findByText("Make the limiter count requests"))
    await screen.findByText(/change 2 of 2/)

    // Act
    await user.click(screen.getByRole("button", { name: "← older" }))

    // Assert
    await screen.findByText(/change 1 of 2/)
    const expected = { olderDisabled: true, newerDisabled: false }
    expect({
      olderDisabled: screen.getByRole("button", { name: "← older" }).hasAttribute("disabled"),
      newerDisabled: screen.getByRole("button", { name: "newer →" }).hasAttribute("disabled"),
    }).toEqual(expected)
    expect(await screen.findByText("export const skeleton = 1")).toBeInTheDocument()
    expect(screen.queryByText("export const counted = 2")).toBeNull()
  })
})
