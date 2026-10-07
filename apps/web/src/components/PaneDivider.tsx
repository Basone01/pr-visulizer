import { useEffect, useRef, useState } from "react"

import { MIN_SIDE_PANE } from "@/hooks/usePanelSizes"

import styles from "./PaneDivider.module.css"

// Drag handle between two panes. During a drag it writes the pane width straight to a CSS
// variable on the shell element — NO React state, so the (expensive) graph/diff panes don't
// re-render on every pointer move. State is committed once on release, for persistence.
type PaneDividerProps = {
  ariaLabel: string
  // The CSS var this handle drives on the shell, e.g. "--graph-width".
  cssVar: string
  // +1 = the pane grows as the pointer moves right (handle right of its pane);
  // -1 = it grows as the pointer moves left (handle left of its pane).
  direction: 1 | -1
  minWidth?: number
  orientation?: "vertical" | "horizontal"
  className?: string | undefined
  onCommit: (px: number) => void
  onReset: () => void
}

type DividerOrientation = "vertical" | "horizontal"
type DragState = { start: number; startSize: number; shell: HTMLElement; target: HTMLElement }

function getTarget(divider: HTMLElement, direction: 1 | -1): HTMLElement | null {
  let sibling = direction === 1 ? divider.previousElementSibling : divider.nextElementSibling
  while (sibling instanceof HTMLElement && sibling.getAttribute("role") === "separator") {
    sibling = direction === 1 ? sibling.previousElementSibling : sibling.nextElementSibling
  }

  return sibling instanceof HTMLElement ? sibling : null
}

function getMinimumSize(element: Element, orientation: DividerOrientation): number {
  if ((element as HTMLElement).dataset.paneFixed === "true") {
    return getSize(element, orientation)
  }

  const minimum = orientation === "vertical" ? "paneMinWidth" : "paneMinHeight"
  const declaredMinimum = Number((element as HTMLElement).dataset[minimum])
  return Number.isFinite(declaredMinimum) ? declaredMinimum : getSize(element, orientation)
}

function getSize(element: Element, orientation: DividerOrientation): number {
  const rect = element.getBoundingClientRect()
  return orientation === "vertical" ? rect.width : rect.height
}

function getContainerSize(element: HTMLElement, orientation: DividerOrientation): number {
  return orientation === "vertical" ? element.clientWidth : element.clientHeight
}

function getMaximumSize(
  shell: HTMLElement,
  target: HTMLElement,
  minSize: number,
  orientation: DividerOrientation
): number {
  const siblingsMinimum = [...shell.children]
    .filter((child) => child !== target)
    .reduce((total, child) => total + getMinimumSize(child, orientation), 0)

  return Math.max(minSize, getContainerSize(shell, orientation) - siblingsMinimum)
}

export function PaneDivider({
  ariaLabel,
  cssVar,
  direction,
  minWidth = MIN_SIDE_PANE,
  orientation = "vertical",
  className,
  onCommit,
  onReset,
}: PaneDividerProps) {
  const dividerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<DragState | null>(null)
  const [valueNow, setValueNow] = useState(minWidth)
  const [valueMax, setValueMax] = useState(minWidth)
  const latestWidth = useRef(minWidth)

  useEffect(() => {
    const divider = dividerRef.current
    const shell = divider?.closest<HTMLElement>("[data-shell], [data-workspace]")
    const target = divider ? getTarget(divider, direction) : null
    if (!shell || !target) return

    const resizeContainer = shell
    const resizeTarget = target
    function refreshAriaValue(): void {
      const current = Math.max(minWidth, getSize(resizeTarget, orientation))
      latestWidth.current = current
      setValueNow(current)
      setValueMax(getMaximumSize(resizeContainer, resizeTarget, minWidth, orientation))
    }

    refreshAriaValue()
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(refreshAriaValue)
    observer.observe(resizeContainer)
    observer.observe(resizeTarget)

    return () => observer.disconnect()
  }, [direction, minWidth, orientation])

  function constrain(shell: HTMLElement, target: HTMLElement, width: number): number {
    const maximum = getMaximumSize(shell, target, minWidth, orientation)
    setValueMax(maximum)
    return Math.max(minWidth, Math.min(width, maximum))
  }

  function applyWidth(shell: HTMLElement, target: HTMLElement, width: number): number {
    const next = constrain(shell, target, width)
    shell.style.setProperty(cssVar, `${next}px`)
    latestWidth.current = next
    setValueNow(next)
    return next
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const shell = event.currentTarget.closest<HTMLElement>("[data-shell], [data-workspace]")
    if (!shell) return

    const target = getTarget(event.currentTarget, direction)
    if (!target) return

    // The flex layout can shrink a saved requested width. Start from the rendered width so the
    // first movement stays under the pointer instead of jumping to the stale CSS variable.
    const current = Math.max(minWidth, getSize(target, orientation))
    const pointerPosition = orientation === "vertical" ? event.clientX : event.clientY
    dragState.current = { start: pointerPosition, startSize: current, shell, target }
    latestWidth.current = current
    setValueNow(current)
    setValueMax(getMaximumSize(shell, target, minWidth, orientation))
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const state = dragState.current
    if (!state) return

    const pointerPosition = orientation === "vertical" ? event.clientX : event.clientY
    applyWidth(state.shell, state.target, state.startSize + direction * (pointerPosition - state.start))
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragState.current) return

    dragState.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    onCommit(latestWidth.current)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 40 : 10
    const amount =
      orientation === "vertical"
        ? event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : null
        : event.key === "ArrowUp"
          ? -step
          : event.key === "ArrowDown"
            ? step
            : null
    if (amount === null) return

    const shell = event.currentTarget.closest<HTMLElement>("[data-shell], [data-workspace]")
    const target = shell ? getTarget(event.currentTarget, direction) : null
    if (!shell || !target) return

    event.preventDefault()
    event.stopPropagation()
    const next = applyWidth(shell, target, getSize(target, orientation) + direction * amount)
    onCommit(next)
  }

  return (
    <div
      ref={dividerRef}
      className={`${styles.divider} ${orientation === "horizontal" ? styles.horizontal : ""} ${className ?? ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuemin={minWidth}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  )
}
