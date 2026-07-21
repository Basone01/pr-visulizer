import { useCallback, useEffect, useState } from "react"

import { type LineSelection, extendSelection, selectLine } from "@/utils/comments/lineSelection"

// Owns the diff pane's live line-range selection (task 5): a plain gutter click anchors and
// a second one completes the range, a shift-click extends, and Esc clears. The transitions
// are the pure functions in lineSelection.ts; this hook is only the React state + the Escape
// key binding.
export type LineSelectionApi = {
  selection: LineSelection | null
  // A plain gutter click. Anchors, completes a range, or starts over — see `selectLine`.
  select: (line: number) => void
  // A shift-click: always extends from the existing anchor.
  extend: (line: number) => void
  clear: () => void
}

export function useLineSelection(): LineSelectionApi {
  const [selection, setSelection] = useState<LineSelection | null>(null)

  const select = useCallback(
    (line: number) => setSelection((current) => selectLine(current, line)),
    []
  )
  const extend = useCallback(
    (line: number) => setSelection((current) => extendSelection(current, line)),
    []
  )
  const clear = useCallback(() => setSelection(null), [])

  // Esc cancels an in-progress selection (and any open composer that reads it). CAPTURE phase
  // so a focused element's stopPropagation can't swallow it (same reason as the other Esc
  // handlers).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return

      event.preventDefault()
      setSelection(null)
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  return { selection, select, extend, clear }
}
