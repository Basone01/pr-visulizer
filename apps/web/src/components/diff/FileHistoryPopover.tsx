import type { PrCommit } from "@pr-visulizer/shared"
import { useRef } from "react"

import { useDismissablePopover } from "@/hooks/useDismissablePopover"

import styles from "./CommitRangePicker.module.css"
import { CommitRow } from "./CommitRow"

// The file history list (§10): the PR commits that touched the open file, newest-first. Picking
// one shows only that commit's change to this file, through the commit-range lens.
export function FileHistoryPopover({
  entries,
  activeSha,
  truncated,
  isLoading,
  error,
  onPick,
  onClose,
}: {
  // Newest-first.
  entries: PrCommit[]
  activeSha: string | null
  truncated: boolean
  isLoading: boolean
  error: string | null
  onPick: (sha: string) => void
  onClose: () => void
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  useDismissablePopover(popoverRef, onClose)

  const changeCount = entries.length
  const countLabel = `${changeCount} ${changeCount === 1 ? "change" : "changes"} to this file`

  return (
    <div className={styles.popover} ref={popoverRef} role="dialog" aria-label="File history">
      <div className={styles.popoverHeader}>
        <span>File history</span>
      </div>

      {isLoading && <div className={styles.empty}>Loading file history…</div>}
      {error !== null && (
        <div className={styles.empty} role="alert">
          Couldn't load this file's history.
        </div>
      )}
      {!isLoading && error === null && changeCount === 0 && (
        <div className={styles.empty}>No commit in this PR touched this file.</div>
      )}

      {changeCount > 0 && (
        <>
          <p className={styles.hint}>{countLabel}</p>
          <ul className={styles.list}>
            {entries.map((commit) => (
              <li key={commit.sha}>
                <CommitRow
                  commit={commit}
                  selected={commit.sha === activeSha}
                  onClick={() => onPick(commit.sha)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {truncated && (
        <p className={styles.truncated} role="status">
          GitHub lists at most 250 commits — older ones aren't shown.
        </p>
      )}
    </div>
  )
}
