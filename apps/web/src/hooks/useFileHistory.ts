import type { PrCommit } from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useState } from "react"

import type { PrTarget } from "@/entity/pr"

import { fileHistoryQueryOptions } from "@/service/queries"

import type { DiffCommitRangeApi } from "./useDiffCommitRange"

// The file history lens (§10): the PR commits that touched the open file, stepped one at a time.
// A step IS a single-commit range on the commit-range lens, so the diff, the chip and the tray
// marks are all reused. This hook owns the popover, the lazy history query and the stepping.
export type FileHistoryApi = {
  popoverOpen: boolean
  togglePopover: () => void
  closePopover: () => void

  // Newest-first, for display.
  entries: PrCommit[]
  truncated: boolean
  isLoading: boolean
  error: string | null

  // The commit the diff currently shows, or null when no history step is active.
  activeSha: string | null
  // 1-based position of the active commit, counted from the oldest. null when none is active.
  activeChange: number | null
  changeCount: number

  pick: (sha: string) => void
  older: () => void
  newer: () => void
  canStepOlder: boolean
  canStepNewer: boolean
  clear: () => void
}

export function useFileHistory(
  target: PrTarget,
  path: string,
  commitRange: DiffCommitRangeApi
): FileHistoryApi {
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Fetched only once the reviewer first opens the popover, then kept for the chip's stepping.
  const [requested, setRequested] = useState(false)
  const historyQuery = useQuery(fileHistoryQueryOptions(target, path, requested))
  // Oldest-first, the canonical PR order, as the API returns it.
  const commits = useMemo(() => historyQuery.data?.commits ?? [], [historyQuery.data])
  const entries = useMemo(() => [...commits].reverse(), [commits])

  const { source, historyPath, range, selectSha, clear } = commitRange
  const activeSha = source === "history" && range ? range.headSha : null
  const activeIndex = activeSha ? commits.findIndex((commit) => commit.sha === activeSha) : -1
  const olderCommit = activeIndex > 0 ? commits[activeIndex - 1] : undefined
  const newerCommit = activeIndex >= 0 ? commits[activeIndex + 1] : undefined

  // A history range belongs to the file it was picked on, so on any other file it is dropped.
  // A picker range is PR-wide and stays. Compared against the range's own path, not a previous
  // render's: the pane remounts on every file change, so this hook never sees the old path.
  useEffect(() => {
    if (source === "history" && historyPath !== path) clear()
  }, [source, historyPath, path, clear])

  const togglePopover = useCallback(() => {
    setRequested(true)
    setPopoverOpen((open) => !open)
  }, [])
  const closePopover = useCallback(() => setPopoverOpen(false), [])

  const pick = useCallback(
    (sha: string) => {
      setRequested(true)
      selectSha(sha, path)
    },
    [path, selectSha]
  )
  const older = useCallback(() => {
    if (olderCommit) selectSha(olderCommit.sha, path)
  }, [olderCommit, path, selectSha])
  const newer = useCallback(() => {
    if (newerCommit) selectSha(newerCommit.sha, path)
  }, [newerCommit, path, selectSha])

  return {
    popoverOpen,
    togglePopover,
    closePopover,

    entries,
    truncated: historyQuery.data?.truncated ?? false,
    isLoading: requested && historyQuery.isPending,
    error: historyQuery.error ? String(historyQuery.error) : null,

    activeSha,
    activeChange: activeIndex >= 0 ? activeIndex + 1 : null,
    changeCount: commits.length,

    pick,
    older,
    newer,
    canStepOlder: olderCommit !== undefined,
    canStepNewer: newerCommit !== undefined,
    clear,
  }
}
