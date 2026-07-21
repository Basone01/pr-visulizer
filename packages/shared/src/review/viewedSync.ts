// Reconciling the app's checkmarks with GitHub's own per-file "Viewed" state
// (docs/architecture.md §11). GitHub's checkbox and ours are two INDEPENDENTLY WRITABLE
// copies of one fact — a reviewer can tick a file here or on github.com — so the sync is a
// merge, not a one-way push. These are pure functions: no gateway, no IO, no clock. The BFF
// and the desktop client both drive them, and every rule below is testable on its own.

export type ViewedMergeInput = {
  // This reviewer's checkmarks as the app last stored them.
  local: string[]
  // The paths GitHub currently reports as VIEWED for this reviewer.
  remote: string[]
  // GitHub's set as it stood at the END of the previous successful sync — the common
  // ancestor that makes this a 3-way merge. `null` the first time a PR syncs, when no
  // ancestor has ever been recorded.
  base: string[] | null
}

export type ViewedDelta = {
  toMark: string[]
  toUnmark: string[]
}

function sortedFrom(paths: Set<string>): string[] {
  return [...paths].sort()
}

// Merge the two writable copies into the set both sides should end up holding.
//
// With NO ancestor the only safe answer is the union: nothing has been observed to change,
// so dropping either side's checkmark would be inventing an un-view the reviewer never did.
// (This is also why a first sync can only ever add — GitHub's VIEWED files win into the app,
// and the app's own checkmarks win into GitHub.)
//
// With an ancestor the merge is exact. Membership is binary, so when the two sides disagree
// exactly one of them differs from the ancestor — that is the side that moved, and it wins.
// Which makes the answer simply "the opposite of the ancestor", and un-viewing on github.com
// finally propagates back into the app instead of being re-added by a union.
export function mergeViewedFiles({ local, remote, base }: ViewedMergeInput): string[] {
  const localSet = new Set(local)
  const remoteSet = new Set(remote)

  if (!base) return sortedFrom(new Set([...local, ...remote]))

  const baseSet = new Set(base)
  const merged = new Set<string>()

  for (const path of new Set([...local, ...remote, ...base])) {
    const inLocal = localSet.has(path)
    const inRemote = remoteSet.has(path)

    // The sides agree — no merge to do, just carry the agreed answer.
    if (inLocal === inRemote) {
      if (inLocal) merged.add(path)
      continue
    }

    if (!baseSet.has(path)) merged.add(path)
  }

  return sortedFrom(merged)
}

// What still has to be written to GitHub for its Viewed state to equal `merged`. Callers
// push only this delta — re-marking every reviewed file on every save is what made the old
// one-way sync cost a mutation per file per keystroke-of-a-checkmark.
export function viewedDelta(remote: string[], merged: string[]): ViewedDelta {
  const remoteSet = new Set(remote)
  const mergedSet = new Set(merged)

  return {
    toMark: merged.filter((path) => !remoteSet.has(path)).sort(),
    toUnmark: remote.filter((path) => !mergedSet.has(path)).sort(),
  }
}
