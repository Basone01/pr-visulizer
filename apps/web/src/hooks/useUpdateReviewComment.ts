import { useMutation } from "@tanstack/react-query"
import { useCallback } from "react"

import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"

import { useInvalidateReviewComments } from "./useInvalidateReviewComments"

// Editing one own published comment (docs/architecture.md §11). The write is a real PATCH to
// GitHub, so it is a mutation, and on success the comment list is re-read — the edited body is
// then whatever GitHub says it is, not a locally patched copy.

type EditReviewComment = { commentId: number; body: string }

export function useUpdateReviewComment(target: PrTarget) {
  const invalidateComments = useInvalidateReviewComments(target)

  const mutation = useMutation({
    mutationFn: ({ commentId, body }: EditReviewComment) =>
      getPrClient().updateReviewComment(target, commentId, body),
    // Success only: a rejected PATCH changed nothing on GitHub, so re-reading would just
    // re-render the same comment and imply the edit went somewhere.
    onSuccess: invalidateComments,
  })

  // Answers a promise that REJECTS on failure, which is what lets the editor stay open with the
  // reason and the reviewer's text intact — closing it would lose the words they just wrote.
  // `mutateAsync` is stable, so this stays referentially stable for the memoized diff rows.
  const { mutateAsync } = mutation
  const saveEdit = useCallback(
    (commentId: number, body: string) => mutateAsync({ commentId, body }),
    [mutateAsync]
  )

  return { saveEdit }
}
