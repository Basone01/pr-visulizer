import type { ReviewComment } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { reviewCommentsQueryOptions } from "@/service/queries"

import { useUpdateReviewComment } from "./useUpdateReviewComment"

// Editing a published comment writes to GitHub, so the thread the diff is rendering is stale
// the moment the PATCH lands — same rule as a review submit, and the same shared invalidation.
// A rejected PATCH changed nothing, so it must re-read nothing.

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const updateReviewComment =
  vi.fn<(target: PrTarget, commentId: number, body: string) => Promise<void>>()
const listReviewComments = vi.fn<() => Promise<ReviewComment[]>>()

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({ updateReviewComment, listReviewComments }),
}))

// The comments query belongs to the diff pane, not to this hook — mount it alongside, since an
// invalidate only refetches an ACTIVE query.
function useEditBesideOpenDiff() {
  const comments = useQuery(reviewCommentsQueryOptions(target))
  const { saveEdit } = useUpdateReviewComment(target)

  return { comments, saveEdit }
}

function renderEditHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return renderHook(() => useEditBesideOpenDiff(), { wrapper })
}

describe("useUpdateReviewComment", () => {
  beforeEach(() => {
    updateReviewComment.mockReset()
    listReviewComments.mockReset()
    listReviewComments.mockResolvedValue([])
  })

  it("PATCHes the comment and re-reads the thread list on success", async () => {
    // Arrange
    const commentId = 6001
    const editedBody = "Clamp the window to at least 1ms."
    updateReviewComment.mockResolvedValue(undefined)
    const { result } = renderEditHook()
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(1))

    // Act
    await act(() => result.current.saveEdit(commentId, editedBody))

    // Assert — the target rides along with the id and body, and the edited comment is re-read.
    const expectedCall = [target, commentId, editedBody]
    const expectedFetches = 2
    expect(updateReviewComment.mock.calls).toEqual([expectedCall])
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(expectedFetches))
  })

  it("re-reads nothing when the PATCH fails, and surfaces the reason", async () => {
    // Arrange
    const commentId = 6001
    const rejection = new Error("Resource not accessible by personal access token")
    updateReviewComment.mockRejectedValue(rejection)
    const { result } = renderEditHook()
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(1))

    // Act
    const outcome = await act(() => result.current.saveEdit(commentId, "nope").catch((e) => e))

    // Assert — the caller gets the error (that is what keeps the editor open), and the only
    // fetch is still the initial one.
    const expectedFetches = 1
    expect(outcome).toBe(rejection)
    expect(listReviewComments).toHaveBeenCalledTimes(expectedFetches)
  })
})
