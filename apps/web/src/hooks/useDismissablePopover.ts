import { type RefObject, useEffect } from "react"

import { useEscapeKey } from "@/hooks/useEscapeKey"

// The two ways every header popover in the diff pane closes: Escape, and a click anywhere outside.
// They share the "commitPicker" Escape layer, which outranks the diff's own consumers (find, peek,
// selection), so one keypress closes the popover only.
export function useDismissablePopover(
  popoverRef: RefObject<HTMLElement | null>,
  onClose: () => void
): void {
  useEscapeKey("commitPicker", true, onClose)

  // CAPTURE phase for the click-outside: a focused child can call stopPropagation, and a bubble
  // listener would then never fire.
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (popoverRef.current?.contains(event.target as Node)) return

      onClose()
    }

    window.addEventListener("mousedown", onPointerDown, true)
    return () => window.removeEventListener("mousedown", onPointerDown, true)
  }, [popoverRef, onClose])
}
