import { type CommitRange, type PrCommit, commitRange } from "@pr-visulizer/shared"

// A live commit-range selection in the diff pane's picker (docs/architecture.md §10), tracked by
// INDEX into the CANONICAL commit list — oldest-first, as the API returns it — never into the
// order the picker happens to draw. The picker lists commits newest-first; keeping the indices
// canonical is what lets the range math below stay "first selected = oldest" without knowing
// which way the list is drawn. Deliberately the same two-click state machine
// as the diff's line-range selection (utils/comments/lineSelection.ts): a reviewer who has
// learned "click, then click again to complete the range" in the gutter gets the same gesture
// here, rather than a second interaction vocabulary for the same idea.
//
// - "anchored" — one commit is picked. The next click completes a contiguous range to it.
// - "ranged"   — the range is complete. The next click starts a FRESH selection, so moving to
//                another commit never requires pressing Escape first.
export type CommitSelectionPhase = "anchored" | "ranged"

export type CommitSelection = {
  anchor: number
  focus: number
  phase: CommitSelectionPhase
}

export type CommitIndexRange = {
  startIndex: number
  endIndex: number
}

export function beginCommitSelection(index: number): CommitSelection {
  return { anchor: index, focus: index, phase: "anchored" }
}

// Extend to a new commit, keeping the original anchor. Selecting ABOVE the anchor is as valid as
// below — the range is normalized on read — so a reviewer can sweep in either direction.
export function extendCommitSelection(
  selection: CommitSelection | null,
  index: number
): CommitSelection {
  if (!selection) return beginCommitSelection(index)

  return { anchor: selection.anchor, focus: index, phase: "ranged" }
}

// The plain click: first anchors, second completes the range, a third starts over. Clicking the
// SAME commit twice completes it as a single-commit range, which is the common case and must
// never turn into a surprise multi-commit span.
export function selectCommit(selection: CommitSelection | null, index: number): CommitSelection {
  if (!selection || selection.phase === "ranged") return beginCommitSelection(index)

  return extendCommitSelection(selection, index)
}

// The normalized inclusive index range, regardless of which end was clicked first.
export function commitSelectionRange(selection: CommitSelection): CommitIndexRange {
  return {
    startIndex: Math.min(selection.anchor, selection.focus),
    endIndex: Math.max(selection.anchor, selection.focus),
  }
}

export function isCommitInSelection(selection: CommitSelection | null, index: number): boolean {
  if (!selection) return false

  const { startIndex, endIndex } = commitSelectionRange(selection)
  return index >= startIndex && index <= endIndex
}

// Turn a selection into the compare range to fetch. Returns null when the selection can't name a
// real range — no selection, or indices the current commit list doesn't hold — so a caller never
// has to invent a boundary.
//
// The BASE comes from the first selected commit's first parent (the shared `commitRange`), not
// from `sha^`: the compare endpoint documents refs, not git rev syntax. `fallbackBaseSha` (the
// PR's own base) covers a first selected commit with no parents at all.
export function selectedCommitRange(
  selection: CommitSelection | null,
  commits: PrCommit[],
  fallbackBaseSha: string
): CommitRange | null {
  if (!selection) return null

  const { startIndex, endIndex } = commitSelectionRange(selection)
  const first = commits[startIndex]
  const last = commits[endIndex]
  if (!first || !last) return null

  return commitRange(first, last, fallbackBaseSha)
}
