import { useCallback, useEffect, useMemo, useState } from "react"

import { type FileMatch, rankFileMatches } from "@/entity/fileSearch"

import { useEscapeKey } from "@/hooks/useEscapeKey"

// The ⌘P quick-open switcher. Two modes over one list:
//   empty query  → the recent files, MRU order, walked with the chord itself (VS Code's Ctrl+Tab
//                  gesture: hold the modifier, tap P to move down, release to open)
//   typed query  → fuzzy search over every file in the PR, recent matches first
// The whole ranking lives in entity/fileSearch; this hook is only the keyboard machine around it.

// Row 0 is the file already open, so the switcher lands on the one before it.
const INITIAL_SELECTED_INDEX = 1

type OpenPalette = {
  query: string
  // The recent list FROZEN at open time: committing changes the MRU, and a live list would
  // reshuffle the rows under the reviewer mid-traversal.
  recentFiles: string[]
  selectedIndex: number
}

export type RecentFilesPaletteView = {
  query: string
  setQuery: (query: string) => void
  results: FileMatch[]
  selectedIndex: number
}

// Null while the palette is closed — the component renders nothing on it.
export function useRecentFilesPalette(
  recentFiles: string[],
  filePaths: readonly string[],
  onOpenFile: (path: string) => void
): RecentFilesPaletteView | null {
  const [palette, setPalette] = useState<OpenPalette | null>(null)

  const results = useMemo(
    () =>
      palette
        ? rankFileMatches({ filePaths, recentFiles: palette.recentFiles, query: palette.query })
        : [],
    [palette, filePaths]
  )

  // Clamp on read so a shrinking result set never points past the end (same as the find bar).
  const selectedIndex =
    results.length === 0 ? 0 : Math.min(palette?.selectedIndex ?? 0, results.length - 1)

  const close = useCallback(() => setPalette(null), [])

  const setQuery = useCallback((query: string) => {
    // A new query is a new list — start from its best row rather than wherever the highlight sat.
    setPalette((current) => (current ? { ...current, query, selectedIndex: 0 } : current))
  }, [])

  const step = useCallback(
    (direction: number) => {
      setPalette((current) => {
        if (!current || results.length === 0) return current

        const next = (selectedIndex + direction + results.length) % results.length

        return { ...current, selectedIndex: next }
      })
    },
    [results.length, selectedIndex]
  )

  const commit = useCallback(() => {
    const path = results[selectedIndex]?.path

    setPalette(null)
    if (path) onOpenFile(path)
  }, [results, selectedIndex, onOpenFile])

  const isOpen = palette !== null
  // Nothing to switch to and nothing to search — the chord stays inert rather than opening an
  // empty box (it still swallows the keystroke, so the print dialog never appears).
  const hasSomethingToShow = recentFiles.length >= 2 || filePaths.length > 0

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Cmd on macOS, Ctrl elsewhere — accept either rather than sniff the platform.
      const isSwitcherChord =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === "p" || event.key === "P")

      if (isSwitcherChord) {
        // Unconditionally: the browser's print dialog must never open over the app.
        event.preventDefault()

        if (isOpen) step(event.shiftKey ? -1 : 1)
        else if (hasSomethingToShow)
          setPalette({ query: "", recentFiles, selectedIndex: INITIAL_SELECTED_INDEX })

        return
      }

      if (!isOpen) return

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // stopPropagation too: a focused graph node moves itself on the arrow keys.
        event.preventDefault()
        event.stopPropagation()
        step(event.key === "ArrowDown" ? 1 : -1)

        return
      }

      if (event.key === "Enter") {
        event.preventDefault()
        commit()
      }
    }

    // Releasing the held modifier opens the highlighted file. Only while the query is empty: once
    // the reviewer types they released ⌘ long ago, and a stray keyup must not switch files.
    function onKeyUp(event: KeyboardEvent): void {
      if (!palette || palette.query !== "") return
      if (event.key !== "Meta" && event.key !== "Control") return

      commit()
    }

    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)

    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
    }
  }, [palette, isOpen, hasSomethingToShow, recentFiles, step, commit])

  // Escape closes the palette and nothing else — the precedence table puts it above every other
  // surface, so an open switcher can't hand the key to the peek or the pane collapse.
  useEscapeKey("recentFilesPalette", isOpen, close)

  if (!palette) return null

  return { query: palette.query, setQuery, results, selectedIndex }
}
