import { useRef } from "react"

import { MIN_SIDE_PANE, clampSideWidth } from "@/hooks/usePanelSizes"

import styles from "./PaneDivider.module.css"

// Drag handle between two panes. During a drag it writes the pane width straight to a CSS
// variable on the shell element — NO React state, so the (expensive) graph/diff panes don't
// re-render on every pointer move. State is committed once on release, for persistence. The
// live drag and the commit share `clampSideWidth`, so the pane never snaps at release.
type PaneDividerProps = {
  ariaLabel: string
  // The CSS var this handle drives on the shell, e.g. "--graph-width".
  cssVar: string
  // +1 = the pane grows as the pointer moves right (handle right of its pane);
  // -1 = it grows as the pointer moves left (handle left of its pane).
  direction: 1 | -1
  onCommit: (px: number) => void
  onReset: () => void
}

export function PaneDivider({ ariaLabel, cssVar, direction, onCommit, onReset }: PaneDividerProps) {
  const dragState = useRef<{ startX: number; startWidth: number; shell: HTMLElement } | null>(null)
  const latest = useRef(0)

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const shell = event.currentTarget.closest<HTMLElement>("[data-shell]")
    if (!shell) return

    // Fall back to the minimum (not 0) so a first move can't jump from 0px if the var reads blank.
    const current = parseFloat(getComputedStyle(shell).getPropertyValue(cssVar)) || MIN_SIDE_PANE
    dragState.current = { startX: event.clientX, startWidth: current, shell }
    latest.current = current
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const state = dragState.current
    if (!state) return

    const next = clampSideWidth(state.startWidth + direction * (event.clientX - state.startX))
    latest.current = next
    state.shell.style.setProperty(cssVar, `${next}px`)
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragState.current) return

    dragState.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    onCommit(latest.current)
  }

  return (
    <div
      className={styles.divider}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
    />
  )
}
