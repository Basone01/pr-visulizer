import type { ReviewProgress } from "@pr-visulizer/shared"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"

export type Verdict = NonNullable<ReviewProgress["verdict"]>

// The verdict a reviewer has picked is UI-only state until Submit — genuinely local,
// not a mirror of server data, so useState is correct here. Submit forwards the real
// review to the BFF (docs/architecture.md §11).
export function useSubmitReview(target: PrTarget, progress: ReviewProgress | undefined) {
  const [chosenVerdict, setChosenVerdict] = useState<Verdict | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!chosenVerdict) throw new Error("No verdict chosen")

      return getPrClient().submitReview(target, {
        verdict: chosenVerdict,
        body: "",
        comments: progress?.drafts ?? [],
      })
    },
  })

  return {
    chosenVerdict,
    setChosenVerdict,
    submit: () => mutation.mutate(),
    isSubmitting: mutation.isPending,
    isSubmitted: mutation.isSuccess,
  }
}
