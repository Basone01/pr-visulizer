import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import {
  addDraft,
  deleteDraft,
  deleteDrafts,
  draftKey,
  toggleReviewedFile,
  updateDraftBody,
} from "@/utils/review/progress"

import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"
import { progressQueryOptions } from "@/service/queries"

// Review progress lives in TanStack Query (server state), never mirrored in useState.
// Checkmarks are optimistic: flip the cache immediately, PUT the full state, roll back
// on failure (docs/architecture.md §11).

type OptimisticContext = { previous: ReviewProgress | undefined }

// Identifies this PR's progress writes, so onSettled can ask whether a newer one is already in
// flight. Same shape as the scope id, kept in one place so the two cannot drift apart.
function progressMutationKey(target: PrTarget): [string, string] {
  return ["progress", `${target.owner}/${target.repo}#${target.number}`]
}

export function useReviewProgress(target: PrTarget) {
  const queryClient = useQueryClient()
  const options = progressQueryOptions(target)
  const query = useQuery(options)

  // The PUT is full-state replacement, so overlapping mutations would race (the
  // last-arriving snapshot wins and drops the others). The mutation VARIABLE is a transform
  // applied to the fresh cache at start time — not a state snapshot taken when the click
  // happened — so each PUT carries the cumulative state.
  type ProgressTransform = (current: ReviewProgress) => ReviewProgress

  // One write's unit of work: the transform, plus the state this mutation's own onMutate
  // computed from it. `next` rides on the VARIABLES rather than a hook-level ref because
  // `scope` does NOT serialize onMutate — with two rapid toggles both onMutates run before
  // either mutationFn (traced), so a shared ref hands the FIRST PUT the second toggle's state.
  // Variables are per-mutation by construction, which makes that mix-up unrepresentable.
  type ProgressWrite = { transform: ProgressTransform; next: ReviewProgress | null }

  const mutation = useMutation<ReviewProgress, Error, ProgressWrite, OptimisticContext>({
    mutationKey: progressMutationKey(target),
    scope: { id: `progress:${target.owner}/${target.repo}#${target.number}` },
    onMutate: async (write) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      const previous = queryClient.getQueryData<ReviewProgress>(options.queryKey)
      write.next = previous ? write.transform(previous) : null
      if (write.next) queryClient.setQueryData(options.queryKey, write.next)

      return { previous }
    },
    // PUTs exactly the state its own onMutate made optimistic.
    mutationFn: (write) => {
      if (!write.next) throw new Error("review progress not loaded yet")

      return getPrClient().putProgress(target, write.next)
    },
    onError: (_error, _write, context) => {
      if (context?.previous) queryClient.setQueryData(options.queryKey, context.previous)
    },
    onSettled: () => {
      // Another toggle is already in flight — let IT settle the query. Refetching now would ask
      // for state this mutation has already superseded, and that answer lands AFTER the newer
      // optimistic update and reverts it: the checkbox flicks back to its old value on its own
      // before a later read corrects it. Only the last write standing refetches.
      if (queryClient.isMutating({ mutationKey: progressMutationKey(target) }) > 1) return

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

      mutate({ transform, next: null })
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

  // A submitted review published these drafts, so their local copies must go — otherwise the diff
  // shows each comment twice, once as a pending draft and once as the thread it just became.
  // It rides the SAME scoped, transform-based mutation as every other edit, which is what makes
  // it safe against a draft written while the submit was in flight: the transform runs against
  // the cache as it is when the PUT starts, and removes only the keys that were published.
  const discardDrafts = useCallback(
    (published: DraftComment[]) => {
      if (published.length === 0) return

      const keys = published.map(draftKey)
      mutateProgress((current) => deleteDrafts(current, keys))
    },
    [mutateProgress]
  )

  return {
    progress: query.data,
    isLoading: query.isLoading,
    toggleReviewed,
    saveDraft,
    editDraft,
    removeDraft,
    discardDrafts,
  }
}
