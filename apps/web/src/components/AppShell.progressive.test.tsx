import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { pr42Analysis } from "@/service/fixture/pr42"

import { AppShell } from "./AppShell"

// The progressive shell (docs/architecture.md §5, task 4): the moment the OVERVIEW lands the
// tray rows + the analysis-progress panel render — before the (slower) analysis resolves; when
// the analysis lands the graph view swaps in. GraphPane/DiffPane are stubbed so the test targets
// the shell's orchestration, not React-Flow / shiki internals. The analysis promise is held
// pending, then resolved, to drive the swap deterministically.

vi.mock("./graph/GraphPane", () => ({
  GraphPane: () => <div data-testid="graph-pane">graph</div>,
}))
vi.mock("./diff/DiffPane", () => ({
  DiffPane: () => <div data-testid="diff-pane">diff</div>,
}))

const control = vi.hoisted(() => {
  let resolveAnalysis!: (value: unknown) => void
  const analysisPromise = new Promise<unknown>((resolve) => {
    resolveAnalysis = resolve
  })

  return { analysisPromise, resolveAnalysis: (value: unknown) => resolveAnalysis(value) }
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

  const client = {
    getOverview: () => Promise.resolve(overview),
    getAnalysis: () => control.analysisPromise,
    subscribeAnalysisProgress: () => () => {},
    getPatch: () => Promise.resolve(""),
    getProgress: () => Promise.resolve(progress),
    putProgress: (_target: unknown, next: unknown) => Promise.resolve(next),
    submitReview: () => Promise.resolve(),
    getViewer: () => Promise.resolve(viewer),
    listOpenPullRequests: () => Promise.resolve([]),
  }

  return {
    getPrClient: () => client,
    // The shell now reads panel sizes through app storage — a simple in-memory
    // store keeps the test hermetic.
    getAppStorage: () => {
      const memory = new Map<string, string>()
      return {
        get: async (key: string) => memory.get(key) ?? null,
        set: async (key: string, value: string) => {
          memory.set(key, value)
        },
      }
    },
  }
})

function renderShell(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe("AppShell — progressive render", () => {
  it("renders tray rows + the progress panel while analysis is pending, then swaps in the graph", async () => {
    // Arrange
    const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

    // Act — overview resolves; the analysis promise is still pending.
    renderShell(<AppShell target={target} onBack={() => {}} />)

    // Assert — a tray row and the analysis-progress panel are visible; no graph yet.
    expect(await screen.findByText("src/config/limits.ts")).toBeInTheDocument()
    expect(screen.getByText("Analyzing PR…")).toBeInTheDocument()
    expect(screen.queryByTestId("graph-pane")).toBeNull()

    // Act — the analysis resolves.
    control.resolveAnalysis({ status: "ready", result: pr42Analysis })

    // Assert — the graph view swaps in and the progress panel is gone.
    expect(await screen.findByTestId("graph-pane")).toBeInTheDocument()
    expect(screen.queryByText("Analyzing PR…")).toBeNull()
  })
})
