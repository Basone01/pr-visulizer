import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { AppShell } from "./AppShell"

// Opening a PR whose repo has no local clone (docs/tauri-architecture.md §6). The client rejects
// with the typed NeedsRepoSourceError and the shell puts the locate-vs-clone chooser on screen as
// a modal: with no repo source there is nothing behind it to read, so the choice IS the screen.
//
// The desktop parts it drives — the native folder picker and `gh repo clone` — are not reachable
// from jsdom. What is pinned here is the shell's half: when the modal appears, what it names, and
// that cancelling leaves the PR.

vi.mock("./graph/GraphPane", () => ({ GraphPane: () => <div data-testid="graph-pane">graph</div> }))
vi.mock("./diff/DiffPane", () => ({ DiffPane: () => <div data-testid="diff-pane">diff</div> }))

const control = vi.hoisted(() => ({
  // Held open by default: the overview is the SLOWER call on the desktop (it waits on PR meta),
  // and the chooser must not wait for it — see the "before the overview arrives" case.
  overviewPending: true,
}))

vi.mock("@/service/clientFactory", async () => {
  const { NeedsRepoSourceError } = await import("@/entity/repoSource")
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

  const client = {
    getOverview: () =>
      control.overviewPending ? new Promise(() => {}) : Promise.resolve(overview),
    // The desktop client's answer when neither a linked clone nor a clone root exists.
    getAnalysis: () => Promise.reject(new NeedsRepoSourceError("acme", "webapp")),
    subscribeAnalysisProgress: () => () => {},
    getPatch: () => Promise.resolve(""),
    getFileAtHead: () => Promise.resolve(null),
    listReviewComments: () => Promise.resolve([]),
    getProgress: () => Promise.resolve(progress),
    putProgress: (_target: unknown, next: unknown) => Promise.resolve(next),
    submitReview: () => Promise.resolve(),
    getViewer: () =>
      Promise.resolve({ userId: "u", login: "reviewer", name: "R", avatarUrl: null }),
    listOpenPullRequests: () => Promise.resolve([]),
    invalidatePr: () => Promise.resolve(),
  }

  const memory = new Map<string, string>()

  return {
    getPrClient: () => client,
    getAppStorage: () => ({
      get: async (key: string) => memory.get(key) ?? null,
      set: async (key: string, value: string) => {
        memory.set(key, value)
      },
    }),
  }
})

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

function renderShell(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe("AppShell — a PR whose repo has no local clone", () => {
  beforeEach(() => {
    control.overviewPending = true
  })

  it("puts the chooser on screen before the overview has even arrived", async () => {
    // Arrange — the overview never resolves in this case, so anything that waited for it would
    // leave the reviewer watching a progress timeline that can never finish.

    // Act
    renderShell(<AppShell target={target} onBack={() => {}} />)

    // Assert — named after the repo, with both ways forward.
    expect(await screen.findByText(/No local clone for/)).toBeInTheDocument()
    expect(screen.getByText("acme/webapp")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Locate local clone…" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Clone it for me…" })).toBeEnabled()
  })

  it("leaves the PR when the chooser is cancelled", async () => {
    // Arrange
    const user = userEvent.setup()
    const onBack = vi.fn()
    renderShell(<AppShell target={target} onBack={onBack} />)
    await screen.findByText(/No local clone for/)

    // Act
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    // Assert — cancelling is the way back to the repo list; the shell has nothing else to show.
    const expectedCalls = 1
    expect(onBack).toHaveBeenCalledTimes(expectedCalls)
  })

  it("still shows the chooser once the rest of the PR data has loaded", async () => {
    // Arrange — the overview resolves here, so the shell renders its panes; the chooser has to
    // stay on top of them rather than being replaced by the analysis timeline.
    control.overviewPending = false

    // Act
    renderShell(<AppShell target={target} onBack={() => {}} />)

    // Assert
    expect(await screen.findByText(/No local clone for/)).toBeInTheDocument()
  })
})
