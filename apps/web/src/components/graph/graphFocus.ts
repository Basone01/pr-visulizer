import { createContext, useContext } from "react"

import type { LayoutEdge } from "@/utils/graph/elkLayout"

// Which file is open, and which nodes stay in focus around it. The open file's single home is
// `currentPath` in the app shell — this context hands it down to the node and edge components
// instead of copying it into every React Flow node/edge object. Copying it was the big-PR click
// lag: one click rebuilt 400 node objects and 1,600 edge objects, and React Flow re-adopted the
// lot. A context change re-renders the same components, but touches no store and rebuilds no
// object graph.

export type GraphFocus = {
  currentPath: string
  // The open file plus its direct neighbours; null when nothing is open (no dimming at all).
  focusSet: ReadonlySet<string> | null
}

export const NO_FOCUS: GraphFocus = { currentPath: "", focusSet: null }

const GraphFocusContext = createContext<GraphFocus>(NO_FOCUS)

export const GraphFocusProvider = GraphFocusContext.Provider

export function useGraphFocus(): GraphFocus {
  return useContext(GraphFocusContext)
}

// The focus set for the open file: it, plus its direct neighbours. Pure, so the awkward cases
// below are testable without standing up React Flow.
//
// NO_FOCUS — no dimming at all — when nothing is open, and when the open file ISN'T DRAWN: a
// commit range can filter the open file out of the graph (the diff pane already says so with its
// own empty state), and dimming every node around one that isn't there would grey out the whole
// filtered graph to highlight nothing.
export function focusAroundPath(
  currentPath: string,
  edges: LayoutEdge[],
  visiblePaths: ReadonlySet<string>
): GraphFocus {
  if (!currentPath) return NO_FOCUS

  if (!visiblePaths.has(currentPath)) return NO_FOCUS

  const focusSet = new Set<string>([currentPath])
  for (const edge of edges) {
    if (edge.from === currentPath) focusSet.add(edge.to)
    else if (edge.to === currentPath) focusSet.add(edge.from)
  }

  return { currentPath, focusSet }
}

// A node dims when a file is open and this node is neither it nor one of its neighbours.
export function isNodeDimmed(focus: GraphFocus, path: string): boolean {
  return focus.focusSet !== null && !focus.focusSet.has(path)
}

// An edge stays in focus only if it touches the open file; edges between two unrelated files
// dim with them.
export function isEdgeDimmed(focus: GraphFocus, source: string, target: string): boolean {
  return focus.focusSet !== null && source !== focus.currentPath && target !== focus.currentPath
}
