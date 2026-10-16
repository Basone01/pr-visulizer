import type { PrCommit } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { useDiffCommitRange } from "./useDiffCommitRange"

const BASE_SHA = "base000000000000000000000000000000000000"
const CONFIG_SHA = "c0ffee1000000000000000000000000000000001"
const LIMITER_SHA = "c0ffee2000000000000000000000000000000002"

const commits: PrCommit[] = [
  {
    sha: CONFIG_SHA,
    parents: [BASE_SHA],
    messageHeadline: "Add rate-limit config",
    author: "mona",
    authoredAt: "2026-07-01T10:00:00Z",
  },
  {
    sha: LIMITER_SHA,
    parents: [CONFIG_SHA],
    messageHeadline: "Add the rate limiter",
    author: "mona",
    authoredAt: "2026-07-02T10:00:00Z",
  },
]

const listCommits = vi.hoisted(() => vi.fn())

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({
    listCommits,
    getRangeDiff: async () => ({ baseSha: "", headSha: "", files: [], truncated: false }),
  }),
}))

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe("useDiffCommitRange", () => {
  it("select_sha_completes_a_single_commit_range", async () => {
    // Arrange
    listCommits.mockResolvedValue({ commits, truncated: false })
    const { result } = renderHook(() => useDiffCommitRange(target, BASE_SHA), { wrapper })

    // Act
    const path = "src/lib/rateLimiter.ts"
    act(() => result.current.selectSha(LIMITER_SHA, path))

    // Assert
    await waitFor(() => expect(result.current.range).not.toBeNull())
    const expected = {
      range: { baseSha: CONFIG_SHA, headSha: LIMITER_SHA },
      selection: { anchor: 1, focus: 1, phase: "ranged" },
      source: "history",
    }
    expect({
      range: result.current.range,
      selection: result.current.selection,
      source: result.current.source,
    }).toEqual(expected)
  })
})
