import {
  type CommitRange,
  type PrCommit,
  type RangeDiff,
  type RangeDiffFile,
  rangeFileFor,
  rangeTouchedPaths,
} from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { CommitSelection } from "@/utils/commits/commitSelection"

import type { PrTarget } from "@/entity/pr"

import { commitsQueryOptions, rangeDiffQueryOptions } from "@/service/queries"

import { type CommitRangeSource, useCommitRange } from "./useCommitRange"

// The diff pane's commit-range lens (§10), assembled in one place: the picker's open state, the
// commit list, the two-click selection, the range diff, and everything derived from it.
//
// SCOPE: this narrows the DIFF only. The dependency graph, the ranking, the review queue and
// the GitHub "Viewed" checkboxes all stay whole-PR — review ORDER is a property of the whole PR,
// and viewed state maps to whole-PR state on github.com. The tray uses `touchedPaths` purely to
// MARK rows the range doesn't touch; it never reorders or disables them.
export type DiffCommitRangeApi = {
  pickerOpen: boolean
  openPicker: () => void
  closePicker: () => void

  commits: PrCommit[]
  commitsTruncated: boolean
  // False while the PR genuinely has no commits to offer (or they haven't been asked for yet) —
  // the toolbar button hides rather than opening onto an empty list.
  hasCommits: boolean

  selection: CommitSelection | null
  select: (index: number) => void
  // One commit as a completed range, from the file history lens on `path`.
  selectSha: (sha: string, path: string) => void
  clear: () => void
  // null while no range is active. See CommitRangeSource.
  source: CommitRangeSource | null
  // The file a history range belongs to, null for a picker range or none.
  historyPath: string | null

  // null = no range selected; the pane is showing the whole PR, exactly as before this feature.
  range: CommitRange | null
  rangeDiff: RangeDiff | null
  isLoading: boolean
  error: string | null

  // Every path the range touches, under both current and pre-rename names. null when NO range is
  // active, which reads as "every file is in range" — distinct from an empty set, which means a
  // range is active and touches nothing.
  touchedPaths: Set<string> | null
  // The range's file count and short SHAs, for the indicator chip.
  fileCount: number
  // One file's entry in the range diff, or null when the range didn't touch it.
  fileInRange: (path: string) => RangeDiffFile | null
}

export function useDiffCommitRange(target: PrTarget, fallbackBaseSha: string): DiffCommitRangeApi {
  const [pickerOpen, setPickerOpen] = useState(false)

  // The commit list is only fetched once the picker has been opened at least once — a reviewer
  // who never ranges never pays for the call. `keepOpened` latches, so closing the picker with a
  // range still selected doesn't drop the list the chip's labels are read from.
  const [keepOpened, setKeepOpened] = useState(false)
  const commitsQuery = useQuery(commitsQueryOptions(target, keepOpened))
  const commits = useMemo(() => commitsQuery.data?.commits ?? [], [commitsQuery.data])

  const {
    selection,
    range,
    source,
    historyPath,
    select,
    selectSha: selectShaInList,
    clear,
  } = useCommitRange(commits, fallbackBaseSha)
  const rangeDiffQuery = useQuery(rangeDiffQueryOptions(target, range))
  const rangeDiff = rangeDiffQuery.data ?? null

  const openPicker = useCallback(() => {
    setKeepOpened(true)
    setPickerOpen(true)
  }, [])
  const closePicker = useCallback(() => setPickerOpen(false), [])

  // A sha resolves against the commit list, so selecting one latches the list load like opening
  // the picker does.
  const selectSha = useCallback(
    (sha: string, path: string) => {
      setKeepOpened(true)
      selectShaInList(sha, path)
    },
    [selectShaInList]
  )

  const touchedPaths = useMemo(() => (rangeDiff ? rangeTouchedPaths(rangeDiff) : null), [rangeDiff])

  const fileInRange = useCallback(
    (path: string) => (rangeDiff ? rangeFileFor(rangeDiff, path) : null),
    [rangeDiff]
  )

  return {
    pickerOpen,
    openPicker,
    closePicker,

    commits,
    commitsTruncated: commitsQuery.data?.truncated ?? false,
    // Before the first open there is nothing to report on; treat "not asked yet" as available so
    // the button is discoverable, and let the popover say "no commits" if the PR truly has none.
    hasCommits: !keepOpened || commits.length > 0,

    selection,
    select,
    selectSha,
    clear,
    source,
    historyPath,

    range,
    rangeDiff,
    isLoading: rangeDiffQuery.isPending && range !== null,
    error: rangeDiffQuery.error ? String(rangeDiffQuery.error) : null,

    touchedPaths,
    fileCount: rangeDiff?.files.length ?? 0,
    fileInRange,
  }
}
