import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import { addDraft, deleteDraft, toggleReviewedFile, updateDraftBody } from "@/utils/review/progress"

import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"
import { progressQueryOptions } from "@/service/queries"

// Review progress lives in TanStack Query (server state), never mirrored in useState.
// Checkmarks are optimistic: flip the cache immediately, PUT the full state, roll back
// on failure (docs/architecture.md §11).

type OptimisticContext = { previous: ReviewProgress | undefined }

export function useReviewProgress(target: PrTarget) {
  const queryClient = useQueryClient()
  const options = progressQueryOptions(target)
  const query = useQuery(options)

  // The PUT is full-state replacement, so overlapping mutations would race (the
  // last-arriving snapshot wins and drops the others). Two rules prevent that:
  // the mutation VARIABLE is a transform applied to the fresh cache at start time
  // (not a state snapshot taken when the click happened), and same-scope mutations
  // run serially — so each PUT carries the cumulative state.
  type ProgressTransform = (current: ReviewProgress) => ReviewProgress

  const mutation = useMutation<ReviewProgress, Error, ProgressTransform, OptimisticContext>({
    scope: { id: `progress:${target.owner}/${target.repo}#${target.number}` },
    onMutate: async (transform) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      const previous = queryClient.getQueryData<ReviewProgress>(options.queryKey)
      if (previous) queryClient.setQueryData(options.queryKey, transform(previous))

      return { previous }
    },
    // Runs after onMutate, so the cache already holds this mutation's optimistic state.
    mutationFn: () => {
      const next = queryClient.getQueryData<ReviewProgress>(options.queryKey)
      if (!next) throw new Error("review progress not loaded yet")

      return getPrClient().putProgress(target, next)
    },
    onError: (_error, _transform, context) => {
      if (context?.previous) queryClient.setQueryData(options.queryKey, context.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: options.queryKey })
    },
  })

  // These four are handed to memoized rows (400 of them on a big PR), so they must keep the
  // same identity across renders — a fresh closure per render makes every row re-render on
  // every click. `mutate` is stable, and `isLoaded` flips once, when progress first arrives.
  const { mutate } = mutation
  const isLoaded = query.data !== undefined

  const mutateProgress = useCallback(
    (transform: ProgressTransform): void => {
      if (!isLoaded) return

      mutate(transform)
    },
    [isLoaded, mutate]
  )

  const toggleReviewed = useCallback(
    (path: string) => mutateProgress((current) => toggleReviewedFile(current, path)),
    [mutateProgress]
  )

  // Draft comments ride the same optimistic full-state PUT as checkmarks (§9, §11): they live
  // in ReviewProgress.drafts, so both the BFF SQLite and the Tauri Store paths persist them.
  const saveDraft = useCallback(
    (draft: DraftComment) => mutateProgress((current) => addDraft(current, draft)),
    [mutateProgress]
  )

  const editDraft = useCallback(
    (key: string, body: string) => mutateProgress((current) => updateDraftBody(current, key, body)),
    [mutateProgress]
  )

  const removeDraft = useCallback(
    (key: string) => mutateProgress((current) => deleteDraft(current, key)),
    [mutateProgress]
  )

  return {
    progress: query.data,
    isLoading: query.isLoading,
    toggleReviewed,
    saveDraft,
    editDraft,
    removeDraft,
  }
}
