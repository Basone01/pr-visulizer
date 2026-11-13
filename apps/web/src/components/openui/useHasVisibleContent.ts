import { type RefObject, useLayoutEffect, useState } from "react"

// Whether an element shows anything: text, or a drawn element (a diagram's or chart's svg, an
// image, a canvas, a table). Followed with a MutationObserver, so content that arrives after the
// first render (a lazy chart, a layout that finishes later) still counts. Null before the first
// look. This reads the DOM only: what a parse result says is not always what got drawn.
const DRAWN_ELEMENTS = "svg, img, canvas, table"

export function useHasVisibleContent(ref: RefObject<HTMLElement | null>): boolean | null {
  const [hasContent, setHasContent] = useState<boolean | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const look = () =>
      setHasContent(
        (element.textContent ?? "").trim() !== "" || element.querySelector(DRAWN_ELEMENTS) !== null
      )
    look()
    if (typeof MutationObserver === "undefined") return

    const observer = new MutationObserver(look)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [ref])

  return hasContent
}
