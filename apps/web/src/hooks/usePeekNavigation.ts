import { useCallback, useEffect, useMemo, useReducer } from "react"

import { DEFAULT_SETTINGS } from "@/config/settings"

import { initialNavState, makeNavReducer } from "@/utils/peek/peekNavigation"

import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

// React wrapper over the pure peek -> expand -> jump machine (§10). The reducer holds
// all the logic; this hook only wires useReducer + the global Esc handler.

export function usePeekNavigation(
  initialPath: string,
  peekMaxLines = DEFAULT_SETTINGS.peekMaxLines
) {
  const reducer = useMemo(() => makeNavReducer({ peekMaxLines }), [peekMaxLines])
  const [state, dispatch] = useReducer(reducer, initialPath, initialNavState)

  const selectFile = useCallback((path: string) => dispatch({ type: "selectFile", path }), [])

  const peekUsage = useCallback(
    (anchor: SymbolAnchor, definitionLineCount: number) =>
      dispatch({ type: "peekUsage", anchor, definitionLineCount }),
    []
  )

  const expandPeek = useCallback(() => dispatch({ type: "expandPeek" }), [])
  const closePeek = useCallback(() => dispatch({ type: "closePeek" }), [])

  const jumpToDefinition = useCallback(
    (anchor: SymbolAnchor) => dispatch({ type: "jumpToDefinition", anchor }),
    []
  )

  const jumpTo = useCallback((target: OccurrenceRef) => dispatch({ type: "jumpTo", target }), [])
  const back = useCallback(() => dispatch({ type: "back" }), [])
  const clearFlash = useCallback(() => dispatch({ type: "clearFlash" }), [])

  // Esc closes an open peek first, then unwinds the jump stack (§10). CAPTURE phase so a
  // focused React Flow node's stopPropagation can't swallow it before it reaches window
  // (same reason as the AppShell Esc handler).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return

      // Suppress the webview's native Escape default (a page reload in the packaged app).
      event.preventDefault()
      dispatch({ type: "escape" })
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  return {
    state,
    selectFile,
    peekUsage,
    expandPeek,
    closePeek,
    jumpToDefinition,
    jumpTo,
    back,
    clearFlash,
  }
}

export type PeekNavApi = ReturnType<typeof usePeekNavigation>
