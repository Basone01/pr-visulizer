import { type PrCommit, shortSha } from "@pr-visulizer/shared"

import styles from "./CommitRangePicker.module.css"

// One commit in a commit list popover (the range picker, the file history): headline, short sha,
// author, date.
export function CommitRow({
  commit,
  selected,
  onClick,
}: {
  commit: PrCommit
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`${styles.commit} ${selected ? styles.commitSelected : ""}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className={styles.headline}>{commit.messageHeadline}</span>
      <span className={styles.meta}>
        <span className="mono">{shortSha(commit.sha)}</span>
        <span className={styles.author}>{commit.author}</span>
        <span>{authoredDate(commit.authoredAt)}</span>
      </span>
    </button>
  )
}

function authoredDate(authoredAt: string): string {
  // An unparseable/absent date must not blank the row — show nothing rather than "Invalid Date".
  const parsed = new Date(authoredAt)
  if (Number.isNaN(parsed.getTime())) return ""

  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
