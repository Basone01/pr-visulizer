// @vitest-environment node
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import type { AnalysisResponse } from "./prClient"

const getAnalysis = vi.fn<(target: PrTarget, engine: string) => Promise<AnalysisResponse>>()

vi.mock("./clientFactory", () => ({
  getPrClient: () => ({ getAnalysis }),
}))

const { analysisQueryOptions } = await import("./queries")

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
