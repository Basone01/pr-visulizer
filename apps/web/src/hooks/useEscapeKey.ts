import { useEffect, useRef } from "react"

import { type EscapeLayer, pickEscapeOwner } from "@/utils/keyboard/escapePrecedence"

type EscapeClaim = {
  layer: EscapeLayer
  onEscape: () => void
}

// One registry, because there is exactly one window and every claim listened on it. The seven
// listeners that used to fire together on a single keypress are now one CAPTURE-phase listener
// that routes the key to the innermost claim. Capture is required: a focused React Flow node
// calls stopPropagation on Escape, so a bubble-phase window listener never sees a real keypress.
const claims = new Map<number, EscapeClaim>()
let nextClaimId = 1

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return

  // Suppress the webview's native Escape default — in the packaged WKWebView a real Escape
  // reloads the page (synthetic events don't trigger native defaults, so this only bites real
  // keypresses).
  event.preventDefault()

  pickEscapeOwner([...claims.values()])?.onEscape()
}

function addClaim(claim: EscapeClaim): number {
  if (claims.size === 0) window.addEventListener("keydown", onWindowKeyDown, true)

  const id = nextClaimId++
  claims.set(id, claim)

  return id
}

function removeClaim(id: number): void {
  claims.delete(id)

  if (claims.size === 0) window.removeEventListener("keydown", onWindowKeyDown, true)
}

// Claim Escape for `layer` while `active`. Exactly one claim runs per keypress — the innermost
// one per ESCAPE_LAYERS — so a consumer states only when IT wants the key and never has to know
// which of the other surfaces happens to be open.
export function useEscapeKey(layer: EscapeLayer, active: boolean, onEscape: () => void): void {
  // The callback is read through a ref so a fresh closure per render doesn't re-register the
  // claim (re-registration would also reorder it against the other claims).
  const handlerRef = useRef(onEscape)
  handlerRef.current = onEscape

  useEffect(() => {
    if (!active) return

    const id = addClaim({ layer, onEscape: () => handlerRef.current() })
    return () => removeClaim(id)
  }, [layer, active])
}
