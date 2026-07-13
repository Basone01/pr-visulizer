import type { ReviewProgress } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { useReviewProgress } from "./useReviewProgress"

// Regression: progress PUT is full-state replacement, so rapid successive toggles must
// each build on the previous optimistic state AND the PUTs must not overlap — otherwise
// the last-arriving snapshot wins and earlier checkmarks are silently lost.

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

// Stateful in-memory client with PUT latency — the overlap that triggers the race.
let stored: ReviewProgress = {
  userId: "dev-user",
  owner: target.owner,
  repo: target.repo,
  prNumber: target.number,
  headSha: "head0042",
  reviewedFiles: [],
  drafts: [],
}
const putDelayMs = 30

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({
    getProgress: async () => stored,
    putProgress: async (_target: PrTarget, next: ReviewProgress) => {
      await new Promise((resolve) => setTimeout(resolve, putDelayMs))
      stored = next
      return stored
    },
  }),
}))

describe("useReviewProgress rapid toggles", () => {
  it("accumulates all checkmarks when several files are toggled back to back", async () => {
    // Arrange
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const togglesInOneBurst = [
      "src/config/limits.ts",
      "src/types/http.ts",
      "src/lib/rateLimiter.ts",
    ]

    const { result } = renderHook(() => useReviewProgress(target), { wrapper })
    await waitFor(() => expect(result.current.progress).toBeDefined())

    // Act — synchronous burst, no awaiting between clicks (the racing case)
    act(() => {
      for (const path of togglesInOneBurst) result.current.toggleReviewed(path)
    })
    await waitFor(() => expect(queryClient.isMutating()).toBe(0), { timeout: 3000 })

    // Assert — the SERVER-side state holds all three, not just the last one
    const expectedReviewedFiles = togglesInOneBurst
    expect(stored.reviewedFiles).toEqual(expect.arrayContaining(expectedReviewedFiles))
  })
})
