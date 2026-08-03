import { useCallback, useMemo, useReducer } from "react"

import { DEFAULT_SETTINGS } from "@/config/settings"

import { initialNavState, makeNavReducer } from "@/utils/peek/peekNavigation"

import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

import { useEscapeKey } from "@/hooks/useEscapeKey"

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

  // Esc closes an open peek first, then unwinds the jump stack (§10). Claimed only when there is
  // one of those to do: with no peek and an empty stack the `escape` action is a no-op, and the
  // key belongs to whatever sits outside the peek (the shell's pane collapse).
  const hasDetourToUnwind = state.peek !== null || state.jumpStack.length > 0
  useEscapeKey("peek", hasDetourToUnwind, () => dispatch({ type: "escape" }))

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
