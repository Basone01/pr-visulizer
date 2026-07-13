import type { DiffFind } from "@/hooks/useDiffFind"

import styles from "./Diff.module.css"

// The find-in-file bar overlaid top-right of the diff pane (Cmd/Ctrl+F). Enter jumps to the next
// match, Shift+Enter to the previous; Escape (handled globally by the hook) closes it.
export function FindBar({ find }: { find: DiffFind }) {
  const hasMatches = find.matchCount > 0

  return (
    <div className={styles.findBar} role="search">
      <input
        className={styles.findInput}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opening the bar should land the caret
        autoFocus
        aria-label="Find in file"
        placeholder="Find in file"
        value={find.query}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return

          event.preventDefault()
          if (event.shiftKey) find.prev()
          else find.next()
        }}
      />
      <span className={`${styles.findCount} mono`}>
        {hasMatches ? `${find.activeDisplay}/${find.matchCount}` : "0/0"}
      </span>
      <button
        type="button"
        className={styles.findNav}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!hasMatches}
        onClick={find.prev}
      >
        ↑
      </button>
      <button
        type="button"
        className={styles.findNav}
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!hasMatches}
        onClick={find.next}
      >
        ↓
      </button>
      <button
        type="button"
        className={styles.findClose}
        aria-label="Close find"
        title="Close (Esc)"
        onClick={find.close}
      >
        ×
      </button>
    </div>
  )
}
