import { useCallback, useMemo, useReducer } from "react"

import { DEFAULT_SETTINGS } from "@/config/settings"

import { initialNavState, makeNavReducer } from "@/utils/peek/peekNavigation"

import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"
import type { LineSpan } from "@/entity/navigation"

import { useEscapeKey } from "@/hooks/useEscapeKey"

// React wrapper over the pure peek -> expand -> jump machine (§10). The reducer holds
// all the logic; this hook only wires useReducer + the global Esc handler.

export function usePeekNavigation(
  initialPath: string,
  peekMaxLines = DEFAULT_SETTINGS.peekMaxLines,
  usagePeekContextLines = DEFAULT_SETTINGS.usagePeekContextLines
) {
  const reducer = useMemo(
    () => makeNavReducer({ peekMaxLines, usagePeekContextLines }),
    [peekMaxLines, usagePeekContextLines]
  )
  const [state, dispatch] = useReducer(reducer, initialPath, initialNavState)

  const selectFile = useCallback((path: string) => dispatch({ type: "selectFile", path }), [])

  const peekUsage = useCallback(
    (anchor: SymbolAnchor, definitionSpan: LineSpan) =>
      dispatch({ type: "peekUsage", anchor, definitionSpan }),
    []
  )

  const peekUsageSite = useCallback(
    (anchor: SymbolAnchor, target: OccurrenceRef) =>
      dispatch({ type: "peekUsageSite", anchor, target }),
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
    peekUsageSite,
    expandPeek,
    closePeek,
    jumpToDefinition,
    jumpTo,
    back,
    clearFlash,
  }
}

export type PeekNavApi = ReturnType<typeof usePeekNavigation>
