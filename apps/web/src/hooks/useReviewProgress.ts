import type { ReviewProgress } from "@pr-visulizer/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { toggleReviewedFile } from "@/utils/review/progress"

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

  const mutation = useMutation<ReviewProgress, Error, ReviewProgress, OptimisticContext>({
    mutationFn: (next) => getPrClient().putProgress(target, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: options.queryKey })
      const previous = queryClient.getQueryData<ReviewProgress>(options.queryKey)

      queryClient.setQueryData(options.queryKey, next)
      return { previous }
    },
    onError: (_error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(options.queryKey, context.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: options.queryKey })
    },
  })

  function toggleReviewed(path: string): void {
    const current = query.data
    if (!current) return

    mutation.mutate(toggleReviewedFile(current, path))
  }

  return {
    progress: query.data,
    isLoading: query.isLoading,
    toggleReviewed,
  }
}
