import { queryOptions } from "@tanstack/react-query"

import type { Engine, PrTarget, RepoRef } from "@/entity/pr"
import { prKey, repoKey } from "@/entity/pr"
import { isNeedsRepoSourceError } from "@/entity/repoSource"

import { getPrClient } from "./clientFactory"

// Shared query definitions (docs/architecture.md §9). One queryOptions factory per
// resource so prefetch and read never drift on key or fetcher — the type flows from
// the client's return, not a useQuery<T> generic.

export function overviewQueryOptions(target: PrTarget) {
  return queryOptions({
    queryKey: ["overview", prKey(target)] as const,
    queryFn: () => getPrClient().getOverview(target),
    // Meta + the changed-file list are immutable per session (like a patch, §9) — the
    // instant-open payload the shell renders before analysis lands (task 4).
    staleTime: Infinity,
  })
}

export function analysisQueryOptions(target: PrTarget, engine: Engine) {
  return queryOptions({
    queryKey: ["analysis", prKey(target), engine] as const,
    queryFn: () => getPrClient().getAnalysis(target, engine),
    // A ready result is immutable per headSha (like the overview and a patch) — a remount must
    // never re-enter the deep pipeline. `refetchInterval` below drives the 202-poll on its own
    // timer, and the locate/clone retries call `refetch()`; neither consults staleTime.
    staleTime: Infinity,
    // 202-then-poll: keep polling while the engine runs, stop once ready (§9).
    refetchInterval: (query) => (query.state.data?.status === "analyzing" ? 1500 : false),
    // "No repo source yet" is a PROMPT, not a transient failure — retrying can't fix it
    // until the user links or clones, so don't burn retries before showing the prompt.
    retry: (failureCount, error) => !isNeedsRepoSourceError(error) && failureCount < 3,
  })
}

export function progressQueryOptions(target: PrTarget) {
  return queryOptions({
    queryKey: ["progress", prKey(target)] as const,
    queryFn: () => getPrClient().getProgress(target),
  })
}

export function openPullRequestsQueryOptions(repo: RepoRef) {
  return queryOptions({
    queryKey: ["openPulls", repoKey(repo)] as const,
    queryFn: () => getPrClient().listOpenPullRequests(repo),
    // Fetch-on-open with manual refresh (docs/tauri-architecture.md §5) — no background
    // polling in this slice; the list is fresh enough for a session until refetched.
    staleTime: 30_000,
  })
}

export function viewerQueryOptions() {
  return queryOptions({
    queryKey: ["viewer"] as const,
    queryFn: () => getPrClient().getViewer(),
    // Identity is stable for the session — the own-PR Approve guard reads it once (§12).
    staleTime: Infinity,
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

// The head-revision content behind the full-file view (§10). `enabled` is the toggle itself, so
// a reviewer who never turns it on never pays for the fetch — and once fetched, the content is
// immutable per headSha (same reasoning as the patch), so flipping the toggle back and forth,
// or leaving and re-opening the file, re-reads nothing.
export function fileAtHeadQueryOptions(target: PrTarget, path: string, enabled: boolean) {
  return queryOptions({
    queryKey: ["fileAtHead", prKey(target), path] as const,
    queryFn: () => getPrClient().getFileAtHead(target, path),
    staleTime: Infinity,
    enabled: enabled && path.length > 0,
  })
}
