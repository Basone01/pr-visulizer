import { useEffect, useRef, useState } from "react"

import { getAppStorage } from "@/service/clientFactory"

// Widths of the docked panes in px. The diff pane deliberately has no stored width: it fills the
// space left by its adjacent panes, so resizing either neighbor resizes the diff without a second
// competing source of truth. Values persist through the same KeyValueStore in browser and desktop.
export type PanelSizes = { codex: number; codexHeight: number; graph: number; tray: number }

export const DEFAULT_PANEL_SIZES: PanelSizes = { codex: 390, codexHeight: 390, graph: 400, tray: 300 }

export const MIN_SIDE_PANE = 220
export const MIN_CENTER_PANE = 320
export const MIN_CODEX_PANE = 280
export const MIN_CODEX_HEIGHT = 220

const STORAGE_KEY = "panelSizes"
const WIDE_LAYOUT_BREAKPOINT = 1100
const WIDE_LAYOUT_DIVIDERS = 18

// The single source of truth for a side pane's legal width. Used by BOTH the live drag
// (PaneDivider) and the committed value here, so the pane never snaps on release: what the
// user drags to is exactly what gets stored. The other side keeps at least its minimum;
// the center pane (flex:1, min-width:0) absorbs the rest.
export function clampPanelWidth(px: number, minWidth: number): number {
  // The drag handle applies the real sibling-aware maximum. This only normalizes restored values
  // before the DOM exists, so a stale local value cannot make a pane disappear off-screen.
  const max = Math.max(minWidth, window.innerWidth - MIN_CENTER_PANE)
  return Math.max(minWidth, Math.min(px, max))
}

function clampPanelHeight(px: number): number {
  const max = Math.max(MIN_CODEX_HEIGHT, window.innerHeight - MIN_CENTER_PANE)
  return Math.max(MIN_CODEX_HEIGHT, Math.min(px, max))
}

function clampToWindow(sizes: PanelSizes): PanelSizes {
  const normalized = {
    codex: clampPanelWidth(sizes.codex, MIN_CODEX_PANE),
    codexHeight: clampPanelHeight(sizes.codexHeight),
    graph: clampPanelWidth(sizes.graph, MIN_SIDE_PANE),
    tray: clampPanelWidth(sizes.tray, MIN_SIDE_PANE),
  }

  if (window.innerWidth <= WIDE_LAYOUT_BREAKPOINT) return normalized

  // Wide layouts keep all three docked panes visible. Fit their stored preferences before CSS
  // lays them out so flexbox never shrinks a different pane than the one the reviewer resized.
  const availableSideWidth = Math.max(
    MIN_SIDE_PANE * 2,
    window.innerWidth - normalized.codex - MIN_CENTER_PANE - WIDE_LAYOUT_DIVIDERS
  )
  const graph = Math.min(normalized.graph, availableSideWidth - MIN_SIDE_PANE)
  const tray = Math.min(normalized.tray, availableSideWidth - graph)

  return { ...normalized, graph, tray }
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
            setSizes(
              clampToWindow({
                codex: typeof parsed.codex === "number" ? parsed.codex : DEFAULT_PANEL_SIZES.codex,
                codexHeight:
                  typeof parsed.codexHeight === "number"
                    ? parsed.codexHeight
                    : DEFAULT_PANEL_SIZES.codexHeight,
                graph: parsed.graph,
                tray: parsed.tray,
              })
            )
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
