import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { AppShell } from "./AppShell"

// The refresh button, through the shell (docs/architecture.md §9): it first drops the caches the
// client holds per PR — the BFF's analysis job, the desktop client's PR meta — then refetches
// every PR-scoped query. The second half is what a plain `refetch()` would give; the first half
// is why this goes through the client at all, and why the test asserts the ORDER.
//
// GraphPane/DiffPane are stubbed: React-Flow and shiki aren't the subject here.

vi.mock("./graph/GraphPane", () => ({
  GraphPane: () => <div data-testid="graph-pane">graph</div>,
}))
vi.mock("./diff/DiffPane", () => ({
  DiffPane: () => <div data-testid="diff-pane">diff</div>,
}))

const client = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getAnalysis: vi.fn(),
  invalidatePr: vi.fn(),
}))

// The overview REFETCH is held open on purpose, so the assertions can look at the screen
// mid-refresh — the moment a naive implementation would blank the shell out.
const overviewReads = vi.hoisted(() => {
  let count = 0
  let release = () => {}
  let refetchGate = Promise.resolve()

  return {
    reset: () => {
      count = 0
      refetchGate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    // The first read is the app opening the PR; every later one is a refresh, and waits.
    onRead: async () => {
      count += 1
      if (count > 1) await refetchGate
    },
    release: () => release(),
  }
})

vi.mock("@/service/clientFactory", async () => {
  const { pr42Analysis: analysis } = await import("@/service/fixture/pr42")
  const overview = { pr: analysis.pr, files: analysis.files }
  const progress = {
    userId: "u",
    owner: analysis.pr.owner,
    repo: analysis.pr.repo,
    prNumber: analysis.pr.number,
    headSha: analysis.pr.headSha,
    reviewedFiles: [],
    drafts: [],
  }
  const viewer = { userId: "u", login: "reviewer", name: "Reviewer", avatarUrl: null }

  client.getOverview.mockImplementation(async () => {
    await overviewReads.onRead()

    return overview
  })
  client.getAnalysis.mockImplementation(() =>
    Promise.resolve({ status: "ready", result: analysis })
  )
  client.invalidatePr.mockResolvedValue(undefined)

  const memory = new Map<string, string>()

  return {
    getPrClient: () => ({
      ...client,
      subscribeAnalysisProgress: () => () => {},
      getPatch: () => Promise.resolve(""),
      getProgress: () => Promise.resolve(progress),
      putProgress: (_target: unknown, next: unknown) => Promise.resolve(next),
      submitReview: () => Promise.resolve(),
      getViewer: () => Promise.resolve(viewer),
      listOpenPullRequests: () => Promise.resolve([]),
    }),
    getAppStorage: () => ({
      get: async (key: string) => memory.get(key) ?? null,
      set: async (key: string, value: string) => {
        memory.set(key, value)
      },
    }),
  }
})

const PR42: PrTarget = { owner: "acme", repo: "web", number: 42 }
const A_TRAY_ROW = "src/config/limits.ts"

function renderShell(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

// Render the PR screen and wait for its first data, so a later call count can only come
// from the refresh under test.
async function openPr(): Promise<HTMLElement> {
  renderShell(<AppShell target={PR42} onBack={() => {}} />)
  await screen.findByTestId("graph-pane")

  return screen.getByRole("button", { name: "Refresh PR" })
}

describe("AppShell — refresh", () => {
  beforeEach(() => {
    client.invalidatePr.mockClear()
    client.getOverview.mockClear()
    overviewReads.reset()
  })

  it("drops the client's per-PR caches and refetches the PR", async () => {
    // Arrange
    const refreshButton = await openPr()

    // Act
    await userEvent.click(refreshButton)
    overviewReads.release()

    // Assert — the cache drop names this PR, and the queries re-read it afterwards: two reads,
    // the open and the refresh.
    const expectedOverviewReads = 2
    expect(client.invalidatePr.mock.calls).toEqual([[PR42]])
    await waitFor(() => expect(client.getOverview.mock.calls.length).toBe(expectedOverviewReads))
  })

  it("keeps the open PR on screen while the refresh is in flight", async () => {
    // Arrange
    const refreshButton = await openPr()

    // Act — the overview refetch is still held open at this point.
    await userEvent.click(refreshButton)

    // Assert — the graph and the tray rows survive the refresh; only the button goes busy.
    expect(screen.getByTestId("graph-pane")).toBeInTheDocument()
    expect(screen.getByText(A_TRAY_ROW)).toBeInTheDocument()
    expect(refreshButton).toBeDisabled()

    overviewReads.release()
    await waitFor(() => expect(refreshButton).toBeEnabled())
  })
})
