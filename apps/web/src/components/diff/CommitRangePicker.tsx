import type { PrCommit } from "@pr-visulizer/shared"
import { useMemo, useRef } from "react"

import { type CommitSelection, isCommitInSelection } from "@/utils/commits/commitSelection"

import { useDismissablePopover } from "@/hooks/useDismissablePopover"

import styles from "./CommitRangePicker.module.css"
import { CommitRow } from "./CommitRow"

// GitHub's "Changes from commits" dropdown, as this app's two-click range picker (§10). One
// click selects a single commit; a second click on another commit extends to the contiguous
// range between them — the same gesture the diff gutter already uses for a line range.
type CommitRangePickerProps = {
  commits: PrCommit[]
  selection: CommitSelection | null
  // True when GitHub's 250-commit ceiling cut the list short — a reviewer choosing from a
  // silently-short list would believe they were choosing from the whole PR.
  truncated: boolean
  onSelect: (index: number) => void
  onClear: () => void
  onClose: () => void
}

export function CommitRangePicker({
  commits,
  selection,
  truncated,
  onSelect,
  onClear,
  onClose,
}: CommitRangePickerProps) {
  const popoverRef = useRef<HTMLDivElement>(null)

  // Newest first, like every commit list a reviewer already reads (GitHub's own, `git log`) —
  // the commit you just pushed is the one you want to isolate, and it should not be at the
  // bottom of a 40-commit scroll. DISPLAY only: each row keeps its CANONICAL index, so the
  // selection machine and `selectedCommitRange` still see an oldest-first list and a range
  // picked top-to-bottom here still bases at the OLDEST selected commit's parent.
  const rowsNewestFirst = useMemo(
    () => commits.map((commit, index) => ({ commit, index })).reverse(),
    [commits]
  )

  useDismissablePopover(popoverRef, onClose)

  return (
    <div
      className={styles.popover}
      ref={popoverRef}
      role="dialog"
      aria-label="Changes from commits"
    >
      <div className={styles.popoverHeader}>
        <span>Changes from commits</span>
        <button
          type="button"
          className={styles.clearLink}
          onClick={onClear}
          disabled={selection === null}
        >
          all changes
        </button>
      </div>

      <p className={styles.hint}>Click a commit, then another to select a range.</p>

      {commits.length === 0 ? (
        <div className={styles.empty}>No commits to choose from.</div>
      ) : (
        <ul className={styles.list}>
          {rowsNewestFirst.map(({ commit, index }) => {
            return (
              <li key={commit.sha}>
                <CommitRow
                  commit={commit}
                  selected={isCommitInSelection(selection, index)}
                  onClick={() => onSelect(index)}
                />
              </li>
            )
          })}
        </ul>
      )}

      {truncated && (
        <p className={styles.truncated} role="status">
          GitHub lists at most 250 commits — older ones aren't shown.
        </p>
      )}
    </div>
  )
}
