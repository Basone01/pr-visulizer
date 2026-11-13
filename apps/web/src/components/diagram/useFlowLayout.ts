import { useContext, useEffect, useRef, useState } from "react"

import {
  type LayeredGraph,
  type LayeredLayout,
  computeLayeredLayout,
} from "@/utils/diagram/layeredLayout"
import type { LayoutDirection } from "@/utils/diagram/layoutDirection"

import { DiagramLayoutContext } from "./diagramLayoutContext"

export type FlowLayoutState =
  { status: "waiting" } | { status: "ready"; layout: LayeredLayout } | { status: "failed" }

export const LAYOUT_TIMEOUT_MS = 5000

type Run = { abort: AbortController; timeout: ReturnType<typeof setTimeout> }

// One diagram's layouts: at most one per direction, each kept once it settles.
type LayoutCache = {
  graph: LayeredGraph
  states: Map<LayoutDirection, FlowLayoutState>
  running: Map<LayoutDirection, Run>
}

const WAITING: FlowLayoutState = { status: "waiting" }

export type LayoutStateOf = (direction: LayoutDirection) => FlowLayoutState

// Lays one diagram out in each direction it is asked for, once, and keeps every answer: with two
// directions, a diagram costs at most two layouts however its block is resized.
// `chooseWanted` picks the directions from what is already known, e.g. "also top-to-bottom once
// left-to-right turns out to need scrolling". A run keeps going when its direction stops being
// wanted (the answer is kept for later). Runs are only cancelled when the diagram changes or the
// view goes away. `graph` is null while the block streams. A failure or a 5 s timeout is final
// for that direction.
export function useFlowLayouts(
  graph: LayeredGraph | null,
  chooseWanted: (stateOf: LayoutStateOf) => LayoutDirection[]
): LayoutStateOf {
  const run = useContext(DiagramLayoutContext)
  const cacheRef = useRef<LayoutCache | null>(null)
  const [, setRevision] = useState(0)

  // A null graph ("not ready yet") never throws the cache away, only a different diagram does.
  if (graph && cacheRef.current?.graph !== graph) {
    cacheRef.current = { graph, states: new Map(), running: new Map() }
  }
  const cache = graph ? cacheRef.current : null
  const stateOf: LayoutStateOf = (direction) => cache?.states.get(direction) ?? WAITING

  useEffect(() => {
    if (!cache) return

    return () => {
      for (const { abort, timeout } of cache.running.values()) {
        clearTimeout(timeout)
        abort.abort()
      }
      cache.running.clear()
    }
  }, [cache])

  const wantedKey = chooseWanted(stateOf).join(",")
  useEffect(() => {
    if (!cache) return

    for (const direction of wantedKey.split(",") as LayoutDirection[]) {
      if (cache.states.has(direction) || cache.running.has(direction)) continue

      startLayout(cache, direction, run, () => setRevision((revision) => revision + 1))
    }
  }, [cache, wantedKey, run])

  return stateOf
}

function startLayout(
  cache: LayoutCache,
  direction: LayoutDirection,
  run: Parameters<typeof computeLayeredLayout>[2],
  onSettled: () => void
): void {
  const abort = new AbortController()
  let isSettled = false

  const store = (state: FlowLayoutState): void => {
    if (isSettled) return

    isSettled = true
    cache.running.delete(direction)
    cache.states.set(direction, state)
    onSettled()
  }

  // The timeout is the failure, whether or not the runner honours the abort.
  const timeout = setTimeout(() => {
    store({ status: "failed" })
    abort.abort()
  }, LAYOUT_TIMEOUT_MS)
  cache.running.set(direction, { abort, timeout })

  computeLayeredLayout(cache.graph, direction, run, abort.signal)
    .then((layout) => store({ status: "ready", layout }))
    .catch(() => {
      // Cancelled because the diagram or the view went away: not a failure, nothing to keep.
      if (abort.signal.aborted) return

      store({ status: "failed" })
    })
    .finally(() => clearTimeout(timeout))
}
