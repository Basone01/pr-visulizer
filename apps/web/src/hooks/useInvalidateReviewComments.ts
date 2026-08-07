import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import type { PrTarget } from "@/entity/pr"

import { reviewCommentsQueryOptions } from "@/service/queries"

// "Re-read this PR's published comments." Two writers need exactly this and nothing more:
// submitting a review publishes its drafted comments, and editing rewrites one — after either,
// what the diff is rendering is one write out of date.
//
// Deliberately narrower than useRefreshPr's whole-prefix drop: neither write touches PR meta,
// the analysis, or a patch, so re-reading those would be wasted round trips. It is also why
// this lives in one place — two hooks invalidating the same key by hand would drift.
export function useInvalidateReviewComments(target: PrTarget): () => void {
  const queryClient = useQueryClient()

  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: reviewCommentsQueryOptions(target).queryKey })
  }, [queryClient, target])
}
