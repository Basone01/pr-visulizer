// @vitest-environment node
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import type { AnalysisResponse } from "./prClient"

const getAnalysis = vi.fn<(target: PrTarget, engine: string) => Promise<AnalysisResponse>>()

vi.mock("./clientFactory", () => ({
  getPrClient: () => ({ getAnalysis }),
}))

const {
  analysisQueryOptions,
  commitsQueryOptions,
  fileAtHeadQueryOptions,
  fileHistoryQueryOptions,
  openPullRequestsQueryOptions,
  overviewQueryOptions,
  patchQueryOptions,
  prScopeKey,
  progressQueryOptions,
  rangeDiffQueryOptions,
  reviewCommentsQueryOptions,
  viewerQueryOptions,
} = await import("./queries")

const PR42: PrTarget = { owner: "acme", repo: "web", number: 42 }

// A ready analysis is immutable per headSha, so the query is `staleTime: Infinity` — a remount
// must never re-enter the deep pipeline. That must not switch off the 202-then-poll (§9), which
// runs on `refetchInterval`'s own timer: these two tests pin both halves of the contract.

function readyResponse(): AnalysisResponse {
  return {
    status: "ready",
    result: {
      engine: "deep",
      pr: {
        owner: PR42.owner,
        repo: PR42.repo,
        number: PR42.number,
        title: "t",
        author: "octocat",
        baseSha: "base42",
        headSha: "head42",
      },
      files: [],
      symbols: [],
      edges: [],
      ranking: [],
      ghosts: [],
      occurrences: [],
    },
  }
}

// `refetchInterval` is declared as a resolver over query state; call it the way the observer's
// interval scheduler does. Only its shape matters here — staleness never reaches it.
function resolveRefetchInterval(data: AnalysisResponse | undefined): number | false | undefined {
  const engine = "deep" as const
  const { refetchInterval } = analysisQueryOptions(PR42, engine)
  if (typeof refetchInterval !== "function") throw new Error("expected a refetchInterval resolver")

  return refetchInterval({ state: { data } } as never)
}

describe("analysisQueryOptions", () => {
  beforeEach(() => {
    getAnalysis.mockReset()
  })

  it("polls while the engine reports analyzing and stops once the result is ready", () => {
    // Arrange
    const analyzing: AnalysisResponse = { status: "analyzing" }
    const ready = readyResponse()

    // Act
    const whileAnalyzing = resolveRefetchInterval(analyzing)
    const onceReady = resolveRefetchInterval(ready)

    // Assert — `staleTime: Infinity` marks a ready result fresh forever, but the 202-poll is
    // driven by this resolver, not by staleness, so it still runs until the engine finishes.
    const expectedPollMs = 1500
    expect(whileAnalyzing).toBe(expectedPollMs)
    expect(onceReady).toBe(false)
  })
})

describe("analysisQueryOptions — a ready result is fetched once per headSha", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getAnalysis.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not refetch on a later remount, well past the app's default staleTime", async () => {
    // Arrange — one mount, resolved.
    const engine = "deep" as const
    getAnalysis.mockResolvedValue(readyResponse())
    const queryClient = new QueryClient()

    const first = new QueryObserver(queryClient, analysisQueryOptions(PR42, engine))
    const unsubscribeFirst = first.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    unsubscribeFirst()

    // Act — remount the same query 60s later (the app's QueryClient default staleTime is 30s).
    const remountAfterMs = 60_000
    await vi.advanceTimersByTimeAsync(remountAfterMs)
    const second = new QueryObserver(queryClient, analysisQueryOptions(PR42, engine))
    const unsubscribeSecond = second.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    // Assert — the deep pipeline ran exactly once; the remount read the cache.
    const expectedCalls = 1
    expect(getAnalysis.mock.calls.length).toBe(expectedCalls)
    expect(second.getCurrentResult().data?.status).toBe("ready")

    unsubscribeSecond()
    queryClient.clear()
  })
})

// The refresh button invalidates ONE key prefix and expects every PR-scoped query to hang off
// it. That contract is invisible at the call site — a new query keyed the old way would simply
// never refresh — so it is pinned here, for both the queries that must be under the prefix and
// the ones that must not.

describe("prScopeKey", () => {
  it("prefixes every PR-scoped query, so one invalidate refreshes the whole PR", () => {
    // Arrange
    const engine = "deep" as const
    const path = "src/config/limits.ts"
    const range = { baseSha: "base42", headSha: "head42" }
    const pickerOpened = true
    const fullFileShown = true
    const historyOpened = true

    const prScoped = [
      overviewQueryOptions(PR42),
      analysisQueryOptions(PR42, engine),
      progressQueryOptions(PR42),
      reviewCommentsQueryOptions(PR42),
      patchQueryOptions(PR42, path),
      commitsQueryOptions(PR42, pickerOpened),
      rangeDiffQueryOptions(PR42, range),
      fileAtHeadQueryOptions(PR42, path, fullFileShown),
      fileHistoryQueryOptions(PR42, path, historyOpened),
    ]

    // Act
    const prefixes = prScoped.map((options) => options.queryKey.slice(0, prScopeKey(PR42).length))

    // Assert
    const expected = prScoped.map(() => ["pr", "acme/web/42"])
    expect(prefixes).toEqual(expected)
  })

  it("keys a file's history by its path under the PR scope", () => {
    // Arrange
    const path = "src/lib/rateLimiter.ts"
    const historyOpened = false

    // Act
    const options = fileHistoryQueryOptions(PR42, path, historyOpened)

    // Assert
    const expected = { queryKey: ["pr", "acme/web/42", "history", path], enabled: false }
    expect({ queryKey: options.queryKey, enabled: options.enabled }).toEqual(expected)
  })

  it("leaves the queries that outlive one PR outside the prefix", () => {
    // Arrange
    const repo = { owner: PR42.owner, repo: PR42.repo }
    const notPrScoped = [openPullRequestsQueryOptions(repo), viewerQueryOptions()]

    // Act
    const roots = notPrScoped.map((options) => options.queryKey[0])

    // Assert — refreshing a PR must not re-read the repo's open-PR list or the viewer identity.
    const expected = ["openPulls", "viewer"]
    expect(roots).toEqual(expected)
  })
})
