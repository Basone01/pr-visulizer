// The files the reviewer has moved through, most recent first — the list behind the ⌘P switcher.
// It is HISTORY, not something derivable from the open path, so it lives as its own small pure
// model here and the hook only feeds it the path the diff pane currently shows.

// VS Code keeps its switcher list short on purpose: past ten entries nobody recognizes the row
// they want faster than typing the name.
export const RECENT_FILES_LIMIT = 10

// Move `path` to the front, dropping any earlier visit of the same file, and cap the list.
export function updateRecentFiles(recentFiles: readonly string[], path: string): string[] {
  // The shell selects the empty path to mean "nothing open" (Escape blurs the selection) — that
  // is not a file and must never enter the history.
  if (path === "") return [...recentFiles]

  const withoutPath = recentFiles.filter((recentPath) => recentPath !== path)

  return [path, ...withoutPath].slice(0, RECENT_FILES_LIMIT)
}
