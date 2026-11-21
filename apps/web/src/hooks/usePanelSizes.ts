import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import { getAppStorage } from "@/service/clientFactory"

// Widths of the docked panes in px. The diff pane deliberately has no stored width: it fills the
// space left by its adjacent panes, so resizing either neighbor resizes the diff without a second
// competing source of truth. Values persist through the same KeyValueStore in browser and desktop.
export type PanelSizes = { codex: number; codexHeight: number; graph: number; tray: number }

export const DEFAULT_PANEL_SIZES: PanelSizes = {
  codex: 390,
  codexHeight: 390,
  graph: 400,
  tray: 300,
}

export const MIN_SIDE_PANE = 220
export const MIN_CENTER_PANE = 320
export const MIN_CODEX_PANE = 280
export const MIN_CODEX_HEIGHT = 220

const STORAGE_KEY = "panelSizes"
// Matches the `max-width: 1100px` media query in AppShell.module.css, where Codex stacks under
// the review instead of sitting beside it.
const WIDE_LAYOUT_BREAKPOINT = 1100
const PANE_DIVIDER_WIDTH = 6
// The graph and tray dividers inside the review shell.
const SHELL_DIVIDERS_WIDTH = 2 * PANE_DIVIDER_WIDTH

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

// The Codex pane has no maximum width of its own: it may cover the whole review workspace,
// which clips. Only its drag handle has to stay on screen, so the pane can be dragged back.
function clampCodexWidth(px: number): number {
  const max = Math.max(MIN_CODEX_PANE, window.innerWidth - PANE_DIVIDER_WIDTH)
  return Math.max(MIN_CODEX_PANE, Math.min(px, max))
}

function clampPanelHeight(px: number): number {
  const max = Math.max(MIN_CODEX_HEIGHT, window.innerHeight - MIN_CENTER_PANE)
  return Math.max(MIN_CODEX_HEIGHT, Math.min(px, max))
}

function clampToWindow(sizes: PanelSizes): PanelSizes {
  return {
    codex: clampCodexWidth(sizes.codex),
    codexHeight: clampPanelHeight(sizes.codexHeight),
    graph: clampPanelWidth(sizes.graph, MIN_SIDE_PANE),
    tray: clampPanelWidth(sizes.tray, MIN_SIDE_PANE),
  }
}

// Derived on every render and never stored, so a wide Codex pane or a small window only narrows
// the side panes while it lasts. The saved widths come back when the room does.
// Side panes never shrink on their own (flex: 0 0 auto), so this fit is what keeps the diff on
// screen, in both layouts. Below the point where every pane fits at its minimum, the diff still
// fits and the shell scrolls sideways to reach the tray.
export function fitSidePanesToWindow(sizes: PanelSizes, windowWidth: number): PanelSizes {
  const isWideLayout = windowWidth > WIDE_LAYOUT_BREAKPOINT
  // In the narrow layout Codex stacks under the review, so it takes no width from this row.
  const codexWidth = isWideLayout ? sizes.codex + PANE_DIVIDER_WIDTH : 0

  // Fit the saved widths before CSS lays them out so flexbox never shrinks a different pane
  // than the one the reviewer resized.
  const availableSideWidth = Math.max(
    MIN_SIDE_PANE * 2,
    windowWidth - codexWidth - MIN_CENTER_PANE - SHELL_DIVIDERS_WIDTH
  )
  const graph = Math.min(sizes.graph, availableSideWidth - MIN_SIDE_PANE)
  const tray = Math.min(sizes.tray, availableSideWidth - graph)

  return { ...sizes, graph, tray }
}

function subscribeToWindowResize(onResize: () => void): () => void {
  window.addEventListener("resize", onResize)
  return () => window.removeEventListener("resize", onResize)
}

function readWindowWidth(): number {
  return window.innerWidth
}

export function usePanelSizes() {
  // The reviewer's saved widths. What the panes render at is fitted from these on the way out.
  const [sizes, setSizes] = useState<PanelSizes>(DEFAULT_PANEL_SIZES)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Re-renders on window resize, so the fit below follows the window instead of waiting for
  // an unrelated render.
  const windowWidth = useSyncExternalStore(subscribeToWindowResize, readWindowWidth)

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

  return { sizes: fitSidePanesToWindow(sizes, windowWidth), commit, reset }
}
