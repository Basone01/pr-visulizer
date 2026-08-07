import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"

import { useInvalidateReviewComments } from "./useInvalidateReviewComments"

export type Verdict = NonNullable<ReviewProgress["verdict"]>

// The verdict a reviewer has picked is UI-only state until Submit — genuinely local,
// not a mirror of server data, so useState is correct here. Submit forwards the real
// review to the BFF (docs/architecture.md §11).
// Drops the drafts a submit just published (useReviewProgress owns the write, so the submit
// borrows it rather than opening a second, racing path to the same progress record).
type DiscardDrafts = (published: DraftComment[]) => void

export function useSubmitReview(
  target: PrTarget,
  progress: ReviewProgress | undefined,
  discardDrafts: DiscardDrafts
) {
  const [chosenVerdict, setChosenVerdict] = useState<Verdict | null>(null)
  const invalidateComments = useInvalidateReviewComments(target)

  const mutation = useMutation({
    // Returns exactly what was POSTed, so the success path drops precisely those drafts —
    // reading `progress.drafts` again afterwards could pick up one written mid-flight.
    mutationFn: async (): Promise<DraftComment[]> => {
      if (!chosenVerdict) throw new Error("No verdict chosen")

      const submitted = progress?.drafts ?? []
      await getPrClient().submitReview(target, {
        verdict: chosenVerdict,
        body: "",
        comments: submitted,
      })

      return submitted
    },
    // The POST publishes the drafted comments on GitHub, so the thread list the diff is
    // rendering went stale the moment it returned — without the re-read, the reviewer's own
    // comments only appear on the next refresh, and without the discard each one shows twice
    // (once as the pending draft it no longer is). onSuccess only: a FAILED submit posted
    // nothing, so it must neither re-read nor drop a draft the reviewer still needs.
    onSuccess: (submitted) => {
      discardDrafts(submitted)
      invalidateComments()
    },
  })

  return {
    chosenVerdict,
    setChosenVerdict,
    submit: () => mutation.mutate(),
    isSubmitting: mutation.isPending,
    isSubmitted: mutation.isSuccess,
    // A failed submit posted nothing to GitHub, so the reason has to reach the reviewer —
    // otherwise the button just goes quiet and the review looks sent.
    submitError: mutation.error ? mutation.error.message : null,
    // Clears a failed attempt, so closing and reopening the confirm dialog starts clean.
    resetSubmit: mutation.reset,
  }
}
