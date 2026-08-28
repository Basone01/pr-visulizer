import type { ReactNode } from "react"

import { type FileMatch, baseNameStart } from "@/entity/fileSearch"

import { useRecentFilesPalette } from "@/hooks/useRecentFilesPalette"

import styles from "./RecentFilesPalette.module.css"

// The ⌘P quick-open palette. Renders nothing until the chord opens it; the keyboard machine and
// the ranking both live outside this file, so this is a plain view over `results`.

type RecentFilesPaletteProps = {
  recentFiles: string[]
  // Every file in the PR — what a typed query searches. The empty query lists `recentFiles`.
  filePaths: readonly string[]
  onOpenFile: (path: string) => void
}

export function RecentFilesPalette({
  recentFiles,
  filePaths,
  onOpenFile,
}: RecentFilesPaletteProps) {
  const palette = useRecentFilesPalette(recentFiles, filePaths, onOpenFile)

  if (!palette) return null

  const { query, setQuery, results, selectedIndex } = palette

  return (
    <div className={styles.backdrop}>
      <div className={styles.card} role="dialog" aria-label="Recent files">
        <input
          className={styles.input}
          type="text"
          value={query}
          autoFocus
          placeholder="Recent files — type to search this PR"
          aria-label="Search files"
          onChange={(event) => setQuery(event.target.value)}
        />

        {results.length === 0 ? (
          <p className={styles.empty}>No matching file</p>
        ) : (
          <ul className={styles.list} role="listbox" aria-label="Files">
            {results.map((match, index) => (
              <FileRow key={match.path} match={match} selected={index === selectedIndex} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function FileRow({ match, selected }: { match: FileMatch; selected: boolean }) {
  const nameStart = baseNameStart(match.path)
  const name = match.path.slice(nameStart)
  const dir = match.path.slice(0, nameStart)

  const nameIndices = match.matchedIndices
    .filter((index) => index >= nameStart)
    .map((index) => index - nameStart)
  const dirIndices = match.matchedIndices.filter((index) => index < nameStart)

  return (
    <li
      className={selected ? `${styles.row} ${styles.selected}` : styles.row}
      role="option"
      aria-selected={selected}
      title={match.path}
    >
      <span className={`${styles.name} mono`}>{markMatches(name, nameIndices)}</span>
      {dir && <span className={`${styles.dir} mono`}>{markMatches(dir, dirIndices)}</span>}
    </li>
  )
}

// The standard quick-open affordance: the characters the query matched are marked and the rest
// stays plain, so the reviewer can see WHY a row is in the list. Per character — the rows are
// short and there are at most MAX_FILE_RESULTS of them.
function markMatches(text: string, indices: number[]): ReactNode {
  if (indices.length === 0) return text

  const matched = new Set(indices)

  return text.split("").map((char, index) =>
    matched.has(index) ? (
      <mark key={index} className={styles.match}>
        {char}
      </mark>
    ) : (
      char
    )
  )
}
