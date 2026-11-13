import { type RefObject, useLayoutEffect, useState } from "react"

// The element's own inline size, live: null until it has been measured once (in a layout effect,
// so before the first paint), then followed with a ResizeObserver where the platform has one.
export function useInlineSize(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    setWidth(element.clientWidth)
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}
