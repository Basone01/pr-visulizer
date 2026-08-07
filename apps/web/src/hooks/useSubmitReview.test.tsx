import type { DraftComment, ReviewComment, ReviewProgress } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { reviewCommentsQueryOptions } from "@/service/queries"

import { useReviewProgress } from "./useReviewProgress"
import { useSubmitReview } from "./useSubmitReview"

// A submitted review publishes its drafted comments on GitHub (§11), which makes two things true
// at once: the diff's thread list is stale, and the local drafts are now duplicates of real
// comments. Both must happen on SUCCESS only — a failed submit posted nothing, so it must leave
// the comment list and every draft exactly as they were.

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const DRAFT_A: DraftComment = {
  path: "src/lib/rateLimiter.ts",
  line: 3,
  side: "RIGHT",
  body: "Guard against a zero window.",
}
const DRAFT_B: DraftComment = {
  path: "src/types/http.ts",
  line: 8,
  side: "RIGHT",
  body: "Is the old field still needed?",
}
// Written while the submit is in flight, so it is NOT part of the submission.
const DRAFT_C: DraftComment = {
  path: "src/api/routes/login.ts",
  line: 21,
  side: "RIGHT",
  body: "Added after the submit started.",
}

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

// The persisted progress record, replaced by each PUT — the same full-state replacement the
// real clients do, so "what survived the submit" is read from the server side, not the cache.
let stored: ReviewProgress = emptyProgress()

const submitReview = vi.fn<() => Promise<void>>()
const listReviewComments = vi.fn<() => Promise<ReviewComment[]>>()

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({
    submitReview,
    listReviewComments,
    getProgress: async () => stored,
    putProgress: async (_target: PrTarget, next: ReviewProgress) => {
      stored = next
      return stored
    },
  }),
}))

// The screen the reviewer is actually on: the diff pane holds the comments query, the shell owns
// review progress, and the tray's submit sits beside both. Composed here because the behavior
// under test only exists in that composition — an invalidate reaches only an ACTIVE query, and
// the draft clearing goes through the progress hook's own write path.
function useReviewScreen() {
  const comments = useQuery(reviewCommentsQueryOptions(target))
  const { progress, saveDraft, discardDrafts } = useReviewProgress(target)
  const submitState = useSubmitReview(target, progress, discardDrafts)

  return { comments, progress, saveDraft, ...submitState }
}

function renderReviewScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return { queryClient, ...renderHook(() => useReviewScreen(), { wrapper }) }
}

function draftPaths(progress: ReviewProgress): string[] {
  return progress.drafts.map((draft) => draft.path)
}

describe("useSubmitReview comment refresh", () => {
  beforeEach(() => {
    stored = emptyProgress()
    submitReview.mockReset()
    listReviewComments.mockReset()
    listReviewComments.mockResolvedValue([])
  })

  it("re-reads the PR's review comments once the submit succeeds", async () => {
    // Arrange
    const chosenVerdict = "comment" as const
    submitReview.mockResolvedValue(undefined)
    const { result } = renderReviewScreen()
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(1))

    // Act
    act(() => result.current.setChosenVerdict(chosenVerdict))
    act(() => result.current.submit())

    // Assert — the just-published comments are fetched again, so they appear in the diff at once.
    const expectedFetches = 2
    await waitFor(() => expect(result.current.isSubmitted).toBe(true))
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(expectedFetches))
  })

  it("leaves the comments alone when the submit fails", async () => {
    // Arrange — a rejected submit posted nothing, so there is nothing new to read.
    const chosenVerdict = "approve" as const
    const rejection = new Error("GitHub rejected the review: pull request is closed")
    submitReview.mockRejectedValue(rejection)
    const { result } = renderReviewScreen()
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(1))

    // Act
    act(() => result.current.setChosenVerdict(chosenVerdict))
    act(() => result.current.submit())

    // Assert — the failure surfaced, and the initial fetch is still the only one.
    const expectedFetches = 1
    await waitFor(() => expect(result.current.submitError).toBe(rejection.message))
    expect(listReviewComments).toHaveBeenCalledTimes(expectedFetches)
  })
})

describe("useSubmitReview draft clearing", () => {
  // Hold the POST open so a draft can be written while it is in flight — the case that decides
  // whether the clear is keyed to the submission or is a blind wipe.
  let releaseSubmit: () => void = () => {}

  beforeEach(() => {
    stored = emptyProgress()
    listReviewComments.mockReset()
    listReviewComments.mockResolvedValue([])
    submitReview.mockReset()
    submitReview.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSubmit = resolve
        })
    )
  })

  async function submitWithDraftAddedMidFlight() {
    const chosenVerdict = "request_changes" as const
    const { result, queryClient } = renderReviewScreen()
    await waitFor(() => expect(result.current.progress).toBeDefined())

    act(() => {
      result.current.saveDraft(DRAFT_A)
      result.current.saveDraft(DRAFT_B)
    })
    await waitFor(() => expect(queryClient.isMutating()).toBe(0))

    act(() => result.current.setChosenVerdict(chosenVerdict))
    act(() => result.current.submit())
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1))

    act(() => result.current.saveDraft(DRAFT_C))

    return { result, queryClient }
  }

  it("drops only the drafts it published, keeping one written mid-flight", async () => {
    // Arrange — A and B are in the submission, C is written while it is still in flight.
    const { result, queryClient } = await submitWithDraftAddedMidFlight()

    // Act
    act(() => releaseSubmit())
    await waitFor(() => expect(result.current.isSubmitted).toBe(true))
    await waitFor(() => expect(queryClient.isMutating()).toBe(0))

    // Assert — the two published drafts are gone (they are real comments now), C survives.
    const expectedDraftPaths = [DRAFT_C.path]
    expect(draftPaths(stored)).toEqual(expectedDraftPaths)
  })

  it("keeps every draft when the submit fails", async () => {
    // Arrange — same three drafts, but the POST rejects, so nothing was published.
    submitReview.mockReset()
    const rejection = new Error("GitHub rejected the review: pull request is closed")
    submitReview.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          releaseSubmit = () => reject(rejection)
        })
    )
    const { result, queryClient } = await submitWithDraftAddedMidFlight()

    // Act
    act(() => releaseSubmit())
    await waitFor(() => expect(result.current.submitError).toBe(rejection.message))
    await waitFor(() => expect(queryClient.isMutating()).toBe(0))

    // Assert — a failed submit is a no-op: the reviewer still has all three drafts to retry with.
    const expectedDraftPaths = [DRAFT_A.path, DRAFT_B.path, DRAFT_C.path]
    expect(draftPaths(stored)).toEqual(expectedDraftPaths)
  })
})
