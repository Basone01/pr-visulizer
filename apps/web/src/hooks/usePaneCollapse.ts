import { useCallback, useEffect, useRef, useState } from "react"

import { getAppStorage } from "@/service/clientFactory"

// Which of the three panes are collapsed to a thin strip. Persisted so a reviewer's
// focus layout survives restarts (same KeyValueStore as panel sizes); Esc restores all.
export type PaneId = "graph" | "diff" | "tray"
export type PaneCollapse = Record<PaneId, boolean>

const ALL_OPEN: PaneCollapse = { graph: false, diff: false, tray: false }
// Focus the graph: diff + tray collapsed to strips, graph left open (Esc toggle).
const GRAPH_ONLY: PaneCollapse = { graph: false, diff: true, tray: true }
const STORAGE_KEY = "paneCollapse"

export function usePaneCollapse() {
  const [collapsed, setCollapsed] = useState<PaneCollapse>(ALL_OPEN)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void getAppStorage()
      .get(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return

        try {
          const parsed = JSON.parse(raw) as Partial<PaneCollapse>
          setCollapsed({
            graph: Boolean(parsed.graph),
            diff: Boolean(parsed.diff),
            tray: Boolean(parsed.tray),
          })
        } catch {
          /* corrupt value → all open */
        }
      })
  }, [])

  function persist(next: PaneCollapse): void {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      void getAppStorage().set(STORAGE_KEY, JSON.stringify(next))
    }, 300)
  }

  const toggle = useCallback((pane: PaneId): void => {
    setCollapsed((current) => {
      const next = { ...current, [pane]: !current[pane] }
      persist(next)
      return next
    })
  }, [])

  function restoreAll(): void {
    setCollapsed(() => {
      persist(ALL_OPEN)
      return ALL_OPEN
    })
  }

  function focusGraph(): void {
    setCollapsed(() => {
      persist(GRAPH_ONLY)
      return GRAPH_ONLY
    })
  }

  const anyCollapsed = collapsed.graph || collapsed.diff || collapsed.tray
  // Only the graph is showing — diff + tray collapsed, graph open.
  const graphOnly = collapsed.diff && collapsed.tray && !collapsed.graph

  return { collapsed, toggle, restoreAll, focusGraph, anyCollapsed, graphOnly }
}
