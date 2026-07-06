import { queryOptions } from "@tanstack/react-query"

import type { Engine, PrTarget } from "@/entity/pr"
import { prKey } from "@/entity/pr"

import { getPrClient } from "./clientFactory"

// Shared query definitions (docs/architecture.md §9). One queryOptions factory per
// resource so prefetch and read never drift on key or fetcher — the type flows from
// the client's return, not a useQuery<T> generic.

export function analysisQueryOptions(target: PrTarget, engine: Engine) {
  return queryOptions({
    queryKey: ["analysis", prKey(target), engine] as const,
    queryFn: () => getPrClient().getAnalysis(target, engine),
    // 202-then-poll: keep polling while the engine runs, stop once ready (§9).
    refetchInterval: (query) => (query.state.data?.status === "analyzing" ? 1500 : false),
  })
}

export function progressQueryOptions(target: PrTarget) {
  return queryOptions({
    queryKey: ["progress", prKey(target)] as const,
    queryFn: () => getPrClient().getProgress(target),
  })
}

export function patchQueryOptions(target: PrTarget, path: string) {
  return queryOptions({
    queryKey: ["patch", prKey(target), path] as const,
    queryFn: () => getPrClient().getPatch(target, path),
    // A file's patch is immutable per headSha — never stale within a session.
    staleTime: Infinity,
    enabled: path.length > 0,
  })
}
