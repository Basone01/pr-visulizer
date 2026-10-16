import type { CommitRange, PrCommit } from "@pr-visulizer/shared"
import { useCallback, useMemo, useState } from "react"

import {
  type CommitSelection,
  selectCommit,
  selectedCommitRange,
} from "@/utils/commits/commitSelection"

// Owns the diff pane's commit-range selection (§10). The transitions are the pure functions in
// commitSelection.ts; this hook is only the React state and the derived range.
//
// The selection lives in PR-SCREEN state on purpose — not localStorage. A range is a temporary
// lens on one reading session ("what did that commit actually change?"), so re-opening a PR
// starts on the whole PR, which is what a reviewer expects to be looking at.

// Where the active range came from. "history" ranges belong to one file (the file history lens),
// so they clear when the open file changes. "picker" ranges are PR-wide and stay.
export type CommitRangeSource = "picker" | "history"

// A picker click is an index into the commit list. A history pick is a sha, because the file
// history can arrive before the PR commit list does. It resolves to an index once the list loads.
// A history pick also keeps the file it was made on, the only file it belongs to.
type SelectionState =
  | { by: "index"; selection: CommitSelection; source: "picker" }
  | { by: "sha"; sha: string; path: string; source: "history" }

export type CommitRangeApi = {
  selection: CommitSelection | null
  // The compare range to fetch, or null when nothing is selected (the whole-PR default).
  range: CommitRange | null
  source: CommitRangeSource | null
  // The file a history range was picked on, null for any other selection.
  historyPath: string | null
  // A click in the picker: anchors, completes a contiguous range, or starts over.
  select: (index: number) => void
  // A file history step on `path`: one commit, completed at once.
  selectSha: (sha: string, path: string) => void
  // Back to "all changes" — the chip's one-click reset.
  clear: () => void
}

export function useCommitRange(commits: PrCommit[], fallbackBaseSha: string): CommitRangeApi {
  const [state, setState] = useState<SelectionState | null>(null)

  const select = useCallback(
    (index: number) =>
      setState((current) => ({
        by: "index",
        selection: selectCommit(resolveSelection(current, commits), index),
        source: "picker",
      })),
    [commits]
  )
  const selectSha = useCallback(
    (sha: string, path: string) => setState({ by: "sha", sha, path, source: "history" }),
    []
  )
  const clear = useCallback(() => setState(null), [])

  const selection = useMemo(() => resolveSelection(state, commits), [state, commits])
  const range = useMemo(
    () => selectedCommitRange(selection, commits, fallbackBaseSha),
    [selection, commits, fallbackBaseSha]
  )

  return {
    selection,
    range,
    source: state?.source ?? null,
    historyPath: state?.by === "sha" ? state.path : null,
    select,
    selectSha,
    clear,
  }
}

function resolveSelection(
  state: SelectionState | null,
  commits: PrCommit[]
): CommitSelection | null {
  if (!state) return null
  if (state.by === "index") return state.selection

  const index = commits.findIndex((commit) => commit.sha === state.sha)
  if (index < 0) return null

  return { anchor: index, focus: index, phase: "ranged" }
}
