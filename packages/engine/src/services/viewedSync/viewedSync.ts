import { type ViewedSync, mergeViewedFiles, viewedDelta } from "@pr-visulizer/shared"

import { mapWithConcurrency } from "../../utils/concurrency.js"
import type { GithubGateway, PrTarget, ViewedFileState } from "../githubGateway/gateway.js"

// Two-way "Viewed" sync (docs/architecture.md §11). The merge RULES are pure and live in
// shared; this is the thin IO shell around them — read GitHub, merge, write back the delta.
// It sits in the engine, beside the gateway, because BOTH drivers need it: the BFF route and
// the desktop client, which talks to the same gateway in-process with no server in between.

// A handful of files change state per save; a small pool keeps a 40-file first sync off a
// serial round-trip-per-file without opening a mutation storm at GitHub.
const VIEWED_WRITE_CONCURRENCY = 4

export type ViewedReconcileInput = {
  target: PrTarget
  // The reviewer's checkmarks as this client holds them right now.
  local: string[]
  // GitHub's viewed set at the end of the previous successful sync — the merge's common
  // ancestor. `null` when this PR has never synced.
  base: string[] | null
}

export type ViewedReconciliation = {
  // The merged truth. The caller persists this as the reviewer's checkmarks.
  reviewedFiles: string[]
  // The new common ancestor to persist — `null` when GitHub could not be read or written, so
  // the caller keeps the ancestor it already has rather than recording a guess. Recording a
  // guess here is what would turn one failed request into a phantom un-view later.
  syncedViewedFiles: string[] | null
  sync: ViewedSync
}

export type ViewedSyncService = {
  reconcile(input: ViewedReconcileInput): Promise<ViewedReconciliation>
}

// DISMISSED means "was viewed, then the file changed underneath" — GitHub shows that file as
// needing another look, so it is NOT viewed as far as our checkmarks are concerned.
function viewedPaths(states: Record<string, ViewedFileState>): string[] {
  return Object.entries(states)
    .filter(([, state]) => state === "VIEWED")
    .map(([path]) => path)
}

function reasonFrom(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub sync failed"
}

export function createViewedSyncService(gateway: GithubGateway): ViewedSyncService {
  // A degraded result NEVER drops a checkmark. The checkmarks are the reviewer's own state;
  // GitHub is a mirror of them, so a mirror we could not write is a sync problem to surface,
  // not a reason to undo the reviewer's work.
  function degraded(reviewedFiles: string[], error: unknown): ViewedReconciliation {
    return {
      reviewedFiles,
      syncedViewedFiles: null,
      sync: { status: "degraded", reason: reasonFrom(error) },
    }
  }

  async function reconcile(input: ViewedReconcileInput): Promise<ViewedReconciliation> {
    const { target, local, base } = input

    let remote: string[]
    try {
      remote = viewedPaths(await gateway.listViewedFiles(target))
    } catch (error) {
      return degraded(local, error)
    }

    const merged = mergeViewedFiles({ local, remote, base })
    const { toMark, toUnmark } = viewedDelta(remote, merged)

    const writes = [
      ...toMark.map((path) => ({ path, viewed: true })),
      ...toUnmark.map((path) => ({ path, viewed: false })),
    ]

    try {
      await mapWithConcurrency(writes, VIEWED_WRITE_CONCURRENCY, (write) =>
        gateway.setFileViewed(target, write.path, write.viewed)
      )
    } catch (error) {
      return degraded(merged, error)
    }

    // GitHub now holds exactly `merged`, which makes it the ancestor for the next merge.
    return { reviewedFiles: merged, syncedViewedFiles: merged, sync: { status: "synced" } }
  }

  return { reconcile }
}
