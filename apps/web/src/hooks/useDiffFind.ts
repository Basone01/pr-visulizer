import { type RefObject, useCallback, useEffect, useMemo, useState } from "react"

import type { DiffLine } from "@/entity/diff"

import { useEscapeKey } from "@/hooks/useEscapeKey"

// Case-insensitive substring search over the parsed diff lines. Returns the indices of the
// matching rows (indices into the same `lines` array the pane renders), in document order.
function matchIndices(lines: DiffLine[], query: string): number[] {
  if (!query) return []

  const needle = query.toLowerCase()
  const out: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.content.toLowerCase().includes(needle)) out.push(index)
  }

  return out
}

export type DiffFind = {
  open: boolean
  query: string
  setQuery: (query: string) => void
  matchCount: number
  activeDisplay: number // 1-based position of the current match, 0 when there are none
  currentRowIndex: number // row index of the current match in the diff, -1 when none
  next: () => void
  prev: () => void
  close: () => void
}

// Browser-style find-in-file for the open diff (WKWebView ships no native find bar). Cmd/Ctrl+F
// opens it; Escape closes it. Search is within the open file only — cross-file search is out of
// scope. `paneRef` is the scroll container the focus returns to on close.
export function useDiffFind(lines: DiffLine[], paneRef: RefObject<HTMLElement | null>): DiffFind {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  const matches = useMemo(() => matchIndices(lines, query), [lines, query])

  // A new query (or a file switch that changes `lines`) starts navigation from the first match.
  useEffect(() => {
    setActive(0)
  }, [query, lines])

  // Clamp on read so a shrinking match set never points past the end.
  const clamped = matches.length === 0 ? 0 : Math.min(active, matches.length - 1)
  const currentRowIndex = matches.length === 0 ? -1 : matches[clamped]!

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setActive(0)
    paneRef.current?.focus()
  }, [paneRef])

  const next = useCallback(() => {
    setActive((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length))
  }, [matches.length])

  const prev = useCallback(() => {
    setActive((current) =>
      matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length
    )
  }, [matches.length])

  // Cmd/Ctrl+F opens the bar, suppressing the browser's own find.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const isFindChord =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === "f" || event.key === "F")
      if (!isFindChord) return

      event.preventDefault()
      setOpen(true)
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  // Escape closes the bar and nothing else — the precedence table puts the open bar above the
  // peek and the pane collapse, so it no longer has to hope the other handlers yield.
  useEscapeKey("findBar", open, close)

  return {
    open,
    query,
    setQuery,
    matchCount: matches.length,
    activeDisplay: matches.length === 0 ? 0 : clamped + 1,
    currentRowIndex,
    next,
    prev,
    close,
  }
}
