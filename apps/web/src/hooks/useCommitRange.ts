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
export type CommitRangeApi = {
  selection: CommitSelection | null
  // The compare range to fetch, or null when nothing is selected (the whole-PR default).
  range: CommitRange | null
  // A click in the picker: anchors, completes a contiguous range, or starts over.
  select: (index: number) => void
  // Back to "all changes" — the chip's one-click reset.
  clear: () => void
}

export function useCommitRange(commits: PrCommit[], fallbackBaseSha: string): CommitRangeApi {
  const [selection, setSelection] = useState<CommitSelection | null>(null)

  const select = useCallback(
    (index: number) => setSelection((current) => selectCommit(current, index)),
    []
  )
  const clear = useCallback(() => setSelection(null), [])

  const range = useMemo(
    () => selectedCommitRange(selection, commits, fallbackBaseSha),
    [selection, commits, fallbackBaseSha]
  )

  return { selection, range, select, clear }
}
