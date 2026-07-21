import { type PrCommit, shortSha } from "@pr-visulizer/shared"
import { useEffect, useRef } from "react"

import { type CommitSelection, isCommitInSelection } from "@/utils/commits/commitSelection"

import styles from "./CommitRangePicker.module.css"

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

function authoredDate(authoredAt: string): string {
  // An unparseable/absent date must not blank the row — show nothing rather than "Invalid Date".
  const parsed = new Date(authoredAt)
  if (Number.isNaN(parsed.getTime())) return ""

  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" })
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

  // Escape closes the picker, and a click anywhere outside it dismisses — the two ways every
  // other popover in the app closes. CAPTURE phase for the same reason as the pane's other
  // Escape handlers: a focused child can call stopPropagation and a bubble listener never fires.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return

      event.preventDefault()
      onClose()
    }

    function onPointerDown(event: MouseEvent): void {
      if (popoverRef.current?.contains(event.target as Node)) return

      onClose()
    }

    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("mousedown", onPointerDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("mousedown", onPointerDown, true)
    }
  }, [onClose])

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
          {commits.map((commit, index) => {
            const selected = isCommitInSelection(selection, index)

            return (
              <li key={commit.sha}>
                <button
                  type="button"
                  className={`${styles.commit} ${selected ? styles.commitSelected : ""}`}
                  aria-pressed={selected}
                  onClick={() => onSelect(index)}
                >
                  <span className={styles.headline}>{commit.messageHeadline}</span>
                  <span className={styles.meta}>
                    <span className="mono">{shortSha(commit.sha)}</span>
                    <span className={styles.author}>{commit.author}</span>
                    <span>{authoredDate(commit.authoredAt)}</span>
                  </span>
                </button>
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
