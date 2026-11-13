import type { CommitRange } from "@pr-visulizer/shared"
import { queryOptions, skipToken } from "@tanstack/react-query"

import type { Engine, PrTarget, RepoRef } from "@/entity/pr"
import { prKey, repoKey } from "@/entity/pr"

import { getPrClient } from "./clientFactory"
import { type GeneratedPatchPolicy, type KnownFileFacts, readFilePatch } from "./filePatch"
import { shouldRetryQuery } from "./queryRetry"

// Shared query definitions (docs/architecture.md §9). One queryOptions factory per
// resource so prefetch and read never drift on key or fetcher — the type flows from
// the client's return, not a useQuery<T> generic.

// Every PR-scoped query hangs off this prefix, so ONE invalidate refreshes the whole PR (the
// top bar's refresh button). Enumerating the resources at the call site instead would rot the
// moment a new PR query is added — and rot silently, as a resource that never refreshes.
// Queries NOT scoped to a PR (the repo's open-PR list, the viewer) keep their own roots.
export function prScopeKey(target: PrTarget) {
  return ["pr", prKey(target)] as const
}

export function overviewQueryOptions(target: PrTarget) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "overview"] as const,
    queryFn: () => getPrClient().getOverview(target),
    // Meta + the changed-file list are immutable per session (like a patch, §9) — the
    // instant-open payload the shell renders before analysis lands (task 4).
    staleTime: Infinity,
  })
}

export function analysisQueryOptions(target: PrTarget, engine: Engine) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "analysis", engine] as const,
    queryFn: () => getPrClient().getAnalysis(target, engine),
    // A ready result is immutable per headSha (like the overview and a patch) — a remount must
    // never re-enter the deep pipeline. `refetchInterval` below drives the 202-poll on its own
    // timer, and the locate/clone retries call `refetch()`; neither consults staleTime.
    staleTime: Infinity,
    // 202-then-poll: keep polling while the engine runs, stop once ready (§9).
    refetchInterval: (query) => (query.state.data?.status === "analyzing" ? 1500 : false),
    // A deterministic failure ("no repo source yet" is a prompt, a schema failure repeats) is
    // shown at once: a retry would only re-run the whole deep pipeline for the same answer.
    retry: shouldRetryQuery,
  })
}

export function progressQueryOptions(target: PrTarget) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "progress"] as const,
    queryFn: () => getPrClient().getProgress(target),
  })
}

// Existing published review comments for the PR (§ "show existing comments"). Fetched when a PR
// is opened and re-fetched on remount, but NOT polled — a reviewer reading threads doesn't need
// a background timer, and a manual refresh (reopening the PR) is enough. Left at the default
// staleTime so opening the PR after commenting elsewhere picks the new threads up.
export function reviewCommentsQueryOptions(target: PrTarget) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "reviewComments"] as const,
    queryFn: () => getPrClient().listReviewComments(target),
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

export type PatchQueryOptions = {
  // "show" on a generated file is the pane's "Show diff anyway". "skip" by default, so a
  // generated file is not read.
  generated?: GeneratedPatchPolicy
  // The analysis's facts for this file, once it has landed.
  known?: KnownFileFacts
}

export function patchQueryOptions(
  target: PrTarget,
  path: string,
  { generated = "skip", known = null }: PatchQueryOptions = {}
) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "patch", path, generated, knownFactsKey(known)] as const,
    queryFn: () => readFilePatch(getPrClient(), { target, path, generated, known }),
    // A file's patch is immutable per headSha — never stale within a session.
    staleTime: Infinity,
    retry: shouldRetryQuery,
    enabled: path.length > 0,
  })
}

// Only facts that change the answer go in the key: a plain file read before the analysis
// landed keeps its cached patch once the analysis says it is plain.
function knownFactsKey(known: KnownFileFacts): string {
  if (known?.skip) return "generated"
  if (known?.diffOmission) return `omitted:${known.diffOmission.reason}`

  return "read"
}

// The PR's commits, behind the diff pane's range picker (§10). The list is immutable per
// headSha like the overview, and it is only fetched once the reviewer actually opens the picker
// — `enabled` is that first open, so a reviewer who never ranges never pays for the call.
export function commitsQueryOptions(target: PrTarget, enabled: boolean) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "commits"] as const,
    queryFn: () => getPrClient().listCommits(target),
    staleTime: Infinity,
    enabled,
  })
}

// One file's history, behind the diff pane's file history lens (§10). Immutable per headSha like
// the commit list, and fetched only once the reviewer first opens the lens (`enabled`).
export function fileHistoryQueryOptions(target: PrTarget, path: string, enabled: boolean) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "history", path] as const,
    queryFn: () => getPrClient().getFileHistory(target, path),
    staleTime: Infinity,
    enabled,
  })
}

// One selected range's diff. Keyed by the RANGE, not by (range, path): the compare endpoint
// answers with every file in the range in a single response, so a per-path key would repeat the
// same upstream call once per file and throw most of each answer away. The open file's patch and
// the set of touched paths are both derived from this one cached result — which is also what
// makes re-selecting a range the reviewer already looked at instant.
//
// `range` is null when nothing is selected. That case is `skipToken` rather than `enabled:
// false` so the queryFn never has to accept a null range and cast it back — the query is
// disabled AND the fetcher's type stays honest. Clearing a range refetches NOTHING: the
// whole-PR patch query never left the cache.
export function rangeDiffQueryOptions(target: PrTarget, range: CommitRange | null) {
  return queryOptions({
    queryKey: [
      ...prScopeKey(target),
      "rangeDiff",
      range?.baseSha ?? "",
      range?.headSha ?? "",
    ] as const,
    queryFn: range ? () => getPrClient().getRangeDiff(target, range) : skipToken,
    // A compare between two fixed SHAs can never change — the strongest immutability in the app.
    staleTime: Infinity,
  })
}

// The head-revision content behind the full-file view (§10). `enabled` is the toggle itself, so
// a reviewer who never turns it on never pays for the fetch — and once fetched, the content is
// immutable per headSha (same reasoning as the patch), so flipping the toggle back and forth,
// or leaving and re-opening the file, re-reads nothing.
export function fileAtHeadQueryOptions(target: PrTarget, path: string, enabled: boolean) {
  return queryOptions({
    queryKey: [...prScopeKey(target), "fileAtHead", path] as const,
    queryFn: () => getPrClient().getFileAtHead(target, path),
    staleTime: Infinity,
    enabled: enabled && path.length > 0,
  })
}
