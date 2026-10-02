import type { ReviewProgress } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { type ReactNode, useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { useReviewProgress } from "./useReviewProgress"

// Reported: "mark checked state unstable when user mark checked a file then immediately unmark
// it". Checking a file then unchecking it before the first write lands must leave the checkbox
// OFF — and, crucially, leave what the reviewer SEES agreeing with what was persisted.
//
// The mechanism this models is a stale READ, not a lost write: each save invalidates the progress
// query, so a rapid double toggle puts two GETs in flight at once. The first carries the
// now-obsolete "checked" state, and if it lands last it wins the cache — the checkbox flips back
// on by itself with the server saying otherwise.
//
// Two details make it reproducible, and both mirror a real server:
//   1. getProgress snapshots the state when the REQUEST arrives, not when it resolves. A real
//      endpoint reads its store at request time; the existing race test's client reads at resolve
//      time, which is why that one cannot express this bug.
//   2. The refetch triggered by the FIRST toggle is slow, the later ones fast — the ordering that
//      lets an obsolete response arrive after a fresh one.

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }
const REVIEWED_FILE = "src/lib/rateLimiter.ts"

function emptyProgress(): ReviewProgress {
  return {
    userId: "dev-user",
    owner: target.owner,
    repo: target.repo,
    prNumber: target.number,
    headSha: "head0042",
    reviewedFiles: [],
    drafts: [],
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The server's copy, plus a per-call read latency so a stale response can land late.
const server = vi.hoisted(() => ({
  stored: null as unknown,
  readDelaysMs: [] as number[],
  reads: 0,
  writes: 0,
  // Write call indexes that should reject, so a rollback can be exercised.
  failWritesAt: [] as number[],
  writeDelayMs: 30,
}))

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({
    getProgress: async () => {
      // Snapshot at request time — what a real GET returns is the state it saw on arrival.
      const snapshot = structuredClone(server.stored) as ReviewProgress
      const delay = server.readDelaysMs[server.reads] ?? 5
      server.reads += 1
      await new Promise((resolve) => setTimeout(resolve, delay))

      return snapshot
    },
    putProgress: async (_target: PrTarget, next: ReviewProgress) => {
      const call = server.writes
      server.writes += 1
      await new Promise((resolve) => setTimeout(resolve, server.writeDelayMs))
      if (server.failWritesAt.includes(call)) throw new Error("save rejected")

      server.stored = structuredClone(next)

      return structuredClone(next)
    },
  }),
}))

// Record what the checkbox SHOWS after every committed render. The reported bug is a transient —
// the state settles correctly — so only the sequence of rendered values can catch it. An effect
// with no deps runs after each commit, so nothing in between is missed.
function useRecordedProgress(rendered: boolean[]) {
  const api = useReviewProgress(target)
  const isChecked = api.progress?.reviewedFiles.includes(REVIEWED_FILE) ?? false

  useEffect(() => {
    if (rendered[rendered.length - 1] !== isChecked) rendered.push(isChecked)
  })

  return api
}

function renderRecordedHook() {
  const rendered: boolean[] = []
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return { queryClient, rendered, ...renderHook(() => useRecordedProgress(rendered), { wrapper }) }
}

function renderProgressHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return { queryClient, ...renderHook(() => useReviewProgress(target), { wrapper }) }
}

describe("useReviewProgress — check then immediately uncheck", () => {
  beforeEach(() => {
    server.stored = emptyProgress()
    server.reads = 0
    server.writes = 0
    server.failWritesAt = []
    // Read 0 is the initial load. Read 1 is the refetch the FIRST toggle triggers — slow, so its
    // obsolete "checked" answer arrives after everything else has settled.
    server.readDelaysMs = [0, 300, 5, 5]
  })

  it("settles OFF, with what is rendered agreeing with what was saved", async () => {
    // Arrange
    const { result, queryClient } = renderProgressHook()
    await waitFor(() => expect(result.current.progress).toBeDefined())

    // Act — check, then uncheck before the first save has landed.
    act(() => {
      result.current.toggleReviewed(REVIEWED_FILE)
      result.current.toggleReviewed(REVIEWED_FILE)
    })

    // Let every write AND every read finish, including the slow one still in flight.
    await waitFor(() => expect(queryClient.isMutating()).toBe(0), { timeout: 3000 })
    await waitFor(() => expect(queryClient.isFetching()).toBe(0), { timeout: 3000 })
    await act(() => sleep(400))

    // Assert — the file is unchecked on the server, and the checkbox the reviewer is looking at
    // says the same thing. A stale read winning the cache shows up here as a rendered [file]
    // against a persisted [].
    const expectedReviewedFiles: string[] = []
    expect((server.stored as ReviewProgress).reviewedFiles).toEqual(expectedReviewedFiles)
    expect(result.current.progress?.reviewedFiles).toEqual(expectedReviewedFiles)
  })
})

describe("useReviewProgress — the checkbox never contradicts the last click", () => {
  beforeEach(() => {
    server.stored = emptyProgress()
    server.reads = 0
    // Desktop shape: every progress round trip carries a GitHub viewed-state reconcile, so reads
    // are slow. The refetch triggered by the FIRST toggle is still in flight when the second
    // toggle lands, and it is carrying the now-obsolete "checked" answer.
    server.writes = 0
    server.failWritesAt = []
    server.readDelaysMs = [0, 300, 5, 5]
    // A desktop save carries a GitHub viewed-state reconcile, so it is slow — slow enough that
    // the second click lands while the first save is still in flight.
    server.writeDelayMs = 400
  })

  it("shows at most one change per click — never a third, self-inflicted one", async () => {
    // Arrange
    const { result, queryClient, rendered } = renderRecordedHook()
    await waitFor(() => expect(result.current.progress).toBeDefined())

    // Act — check, then uncheck a moment later, the way a hand does it. The gap matters: the
    // first save is still in flight, so its optimistic "checked" has rendered and its refetch is
    // about to be issued. Both clicks in one tick would collapse into a single render and hide
    // the very transient this test exists to catch.
    act(() => {
      result.current.toggleReviewed(REVIEWED_FILE)
    })
    await act(() => sleep(150))
    act(() => {
      result.current.toggleReviewed(REVIEWED_FILE)
    })

    await waitFor(() => expect(queryClient.isMutating()).toBe(0), { timeout: 3000 })
    await waitFor(() => expect(queryClient.isFetching()).toBe(0), { timeout: 3000 })
    await act(() => sleep(500))

    // Assert — two clicks may produce at most two visible changes (on, then off). A third means
    // the app changed its mind on its own: the flicker the reviewer reported.
    const expectedRenderedStates = [false, true, false]
    expect(rendered).toEqual(expectedRenderedStates)
  })
})

describe("useReviewProgress — a failed write rolls back to the state before IT ran", () => {
  beforeEach(() => {
    server.stored = emptyProgress()
    server.reads = 0
    server.writes = 0
    server.readDelaysMs = [0, 5, 5, 5]
    server.writeDelayMs = 40
    // The SECOND write fails: the reviewer checks a file, unchecks it, and the uncheck is
    // rejected. The check stood, so that is what must survive on both sides.
    server.failWritesAt = [1]
  })

  it("keeps the first toggle's state on the server when the second toggle is rejected", async () => {
    // Arrange
    const { result, queryClient } = renderProgressHook()
    await waitFor(() => expect(result.current.progress).toBeDefined())

    // Act — check, then uncheck while the check is still saving; the uncheck is rejected.
    act(() => {
      result.current.toggleReviewed(REVIEWED_FILE)
    })
    await act(() => sleep(10))
    act(() => {
      result.current.toggleReviewed(REVIEWED_FILE)
    })

    await waitFor(() => expect(queryClient.isMutating()).toBe(0), { timeout: 3000 })
    await act(() => sleep(200))

    // Assert — each write must carry its OWN state. If the first write is handed the second
    // toggle's state, it persists "unchecked" before the uncheck was ever accepted, and the
    // rollback then leaves the screen saying checked while the server says the opposite.
    const expectedReviewedFiles = [REVIEWED_FILE]
    expect((server.stored as ReviewProgress).reviewedFiles).toEqual(expectedReviewedFiles)
    expect(result.current.progress?.reviewedFiles).toEqual(expectedReviewedFiles)
  })
})
