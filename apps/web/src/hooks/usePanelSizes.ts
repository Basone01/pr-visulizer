import { useEffect, useRef, useState } from "react"

import { getAppStorage } from "@/service/clientFactory"

// Widths of the two side panes (graph, tray) in px; the diff pane flexes between them.
// Persisted so the reviewer's preferred split survives restarts, in both browser
// (localStorage) and desktop (Store plugin) through the same KeyValueStore.
export type PanelSizes = { graph: number; tray: number }

export const DEFAULT_PANEL_SIZES: PanelSizes = { graph: 400, tray: 300 }

export const MIN_SIDE_PANE = 220
export const MIN_CENTER_PANE = 320

const STORAGE_KEY = "panelSizes"

// The single source of truth for a side pane's legal width. Used by BOTH the live drag
// (PaneDivider) and the committed value here, so the pane never snaps on release: what the
// user drags to is exactly what gets stored. The other side keeps at least its minimum;
// the center pane (flex:1, min-width:0) absorbs the rest.
export function clampSideWidth(px: number): number {
  const max = window.innerWidth - MIN_CENTER_PANE - MIN_SIDE_PANE
  return Math.max(MIN_SIDE_PANE, Math.min(px, max))
}

function clampToWindow(sizes: PanelSizes): PanelSizes {
  return { graph: clampSideWidth(sizes.graph), tray: clampSideWidth(sizes.tray) }
}

export function usePanelSizes() {
  const [sizes, setSizes] = useState<PanelSizes>(DEFAULT_PANEL_SIZES)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void getAppStorage()
      .get(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return

        try {
          const parsed = JSON.parse(raw) as Partial<PanelSizes>
          if (typeof parsed.graph === "number" && typeof parsed.tray === "number") {
            setSizes(clampToWindow({ graph: parsed.graph, tray: parsed.tray }))
          }
        } catch {
          /* corrupt value → defaults */
        }
      })
  }, [])

  // Commit a final size after a drag settles: update state (so a later re-render keeps the
  // width) and debounce-persist. NOT called during the drag — that runs on CSS vars only.
  function commit(next: Partial<PanelSizes>): void {
    setSizes((current) => {
      const clamped = clampToWindow({ ...current, ...next })

      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => {
        void getAppStorage().set(STORAGE_KEY, JSON.stringify(clamped))
      }, 300)

      return clamped
    })
  }

  function reset(): void {
    commit(DEFAULT_PANEL_SIZES)
  }

  return { sizes, commit, reset }
}
