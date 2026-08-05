import { useMutation, useQueryClient } from "@tanstack/react-query"

import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"
import { prScopeKey } from "@/service/queries"

// "Show me this PR as it is now" — the top bar's refresh button. Re-reads every PR-scoped
// query (meta, analysis, patches, comments, progress) so commits pushed since the app opened
// the PR appear.
//
// It is a MUTATION, not a bare refetch, for two reasons: the first half genuinely writes
// (dropping caches on the other side of the client boundary), and `isPending` then covers the
// whole drop-then-refetch sequence, which is exactly the window the button must stay busy for.
export type RefreshPrApi = {
  refresh: () => void
  isRefreshing: boolean
}

export function useRefreshPr(target: PrTarget): RefreshPrApi {
  const queryClient = useQueryClient()

  const { mutate, isPending } = useMutation({
    // Order matters: the caches BEHIND the client (the BFF's analysis job, the desktop client's
    // PR meta and prepared repo) are keyed by PR with no head SHA, so refetching first would
    // just re-read the pre-push answer and mark it fresh again.
    mutationFn: async () => {
      await getPrClient().invalidatePr(target)
      await queryClient.invalidateQueries({ queryKey: prScopeKey(target) })
    },
  })

  return { refresh: mutate, isRefreshing: isPending }
}
