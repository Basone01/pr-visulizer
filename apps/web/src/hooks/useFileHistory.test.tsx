import type { PrCommit } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { type DiffCommitRangeApi, useDiffCommitRange } from "./useDiffCommitRange"
import { type FileHistoryApi, useFileHistory } from "./useFileHistory"

const BASE_SHA = "base000000000000000000000000000000000000"
const CONFIG_SHA = "c0ffee1000000000000000000000000000000001"
const DOCS_SHA = "c0ffee2000000000000000000000000000000002"
const LIMITER_SHA = "c0ffee3000000000000000000000000000000003"
const LIMITER_PATH = "src/lib/rateLimiter.ts"
const README_PATH = "README.md"

function commit(sha: string, parent: string, messageHeadline: string): PrCommit {
  return {
    sha,
    parents: [parent],
    messageHeadline,
    author: "mona",
    authoredAt: "2026-07-01T10:00:00Z",
  }
}

// The PR's three commits, oldest-first. Only the first and the last touched the rate limiter.
const prCommits = [
  commit(CONFIG_SHA, BASE_SHA, "Add rate-limit config"),
  commit(DOCS_SHA, CONFIG_SHA, "Document the limits"),
  commit(LIMITER_SHA, DOCS_SHA, "Add the rate limiter"),
]
const historyByPath: Record<string, PrCommit[]> = {
  [LIMITER_PATH]: [prCommits[0]!, prCommits[2]!],
  [README_PATH]: [prCommits[1]!],
}

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({
    listCommits: async () => ({ commits: prCommits, truncated: false }),
    getRangeDiff: async () => ({ baseSha: "", headSha: "", files: [], truncated: false }),
    getFileHistory: async (_target: PrTarget, path: string) => ({
      path,
      commits: historyByPath[path] ?? [],
      truncated: false,
    }),
  }),
}))

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

type Lens = { commitRange: DiffCommitRangeApi; history: FileHistoryApi }

// Both real hooks, wired the way the app does it: the range lives above the pane, and the pane
// REMOUNTS on every file change (AppShell keys its ErrorBoundary by path). A test that only
// re-rendered would miss a rule that depends on the hook seeing the old path.
function renderLens(initialPath: string) {
  const result: { current: Lens } = { current: null as unknown as Lens }

  function Pane({ path, commitRange }: { path: string; commitRange: DiffCommitRangeApi }) {
    result.current = { commitRange, history: useFileHistory(target, path, commitRange) }
    return null
  }

  function Shell({ path }: { path: string }) {
    const commitRange = useDiffCommitRange(target, BASE_SHA)
    return <Pane key={path} path={path} commitRange={commitRange} />
  }

  const view = render(<Shell path={initialPath} />, { wrapper })
  return { result, rerender: ({ path }: { path: string }) => view.rerender(<Shell path={path} />) }
}

describe("useFileHistory", () => {
  it("lists_the_commits_that_touched_the_open_file_newest_first", async () => {
    // Arrange
    const { result } = renderLens(LIMITER_PATH)

    // Act
    act(() => result.current.history.togglePopover())

    // Assert
    const expected = [LIMITER_SHA, CONFIG_SHA]
    await waitFor(() =>
      expect(result.current.history.entries.map((entry) => entry.sha)).toEqual(expected)
    )
  })

  it("stepping_older_applies_the_previous_commit_as_the_range", async () => {
    // Arrange
    const { result } = renderLens(LIMITER_PATH)
    act(() => result.current.history.togglePopover())
    await waitFor(() => expect(result.current.history.entries).toHaveLength(2))
    act(() => result.current.history.pick(LIMITER_SHA))
    await waitFor(() => expect(result.current.history.canStepOlder).toBe(true))

    // Act
    act(() => result.current.history.older())

    // Assert
    const expected = { range: { baseSha: BASE_SHA, headSha: CONFIG_SHA }, activeChange: 1 }
    await waitFor(() =>
      expect({
        range: result.current.commitRange.range,
        activeChange: result.current.history.activeChange,
      }).toEqual(expected)
    )
  })

  it("clears_a_history_range_when_the_file_changes", async () => {
    // Arrange
    const { result, rerender } = renderLens(LIMITER_PATH)
    act(() => result.current.history.pick(LIMITER_SHA))
    await waitFor(() => expect(result.current.commitRange.range).not.toBeNull())

    // Act
    rerender({ path: README_PATH })

    // Assert
    expect(result.current.commitRange.range).toBeNull()
  })

  it("keeps_a_picker_range_when_the_file_changes", async () => {
    // Arrange
    const { result, rerender } = renderLens(LIMITER_PATH)
    const pickedIndex = 1
    act(() => result.current.commitRange.openPicker())
    await waitFor(() => expect(result.current.commitRange.commits).toHaveLength(3))
    act(() => result.current.commitRange.select(pickedIndex))

    // Act
    rerender({ path: README_PATH })

    // Assert
    const expected = { baseSha: CONFIG_SHA, headSha: DOCS_SHA }
    expect(result.current.commitRange.range).toEqual(expected)
  })
})
