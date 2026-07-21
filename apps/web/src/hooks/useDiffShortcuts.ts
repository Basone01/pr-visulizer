import { useEffect } from "react"

import { isEditableTarget } from "@/utils/dom/isEditableTarget"

// Keyboard shortcuts for the open diff (user picked Option deliberately, not Cmd/Ctrl):
//   Option+1 → toggle mark-viewed on the open file
//   Option+2 → open the next suggested file
// One place owns the key→action map so the bindings never drift across scattered listeners.
// Fires only when a file is open and focus is NOT in a text field (composer, find input).
export function useDiffShortcuts({
  enabled,
  onToggleViewed,
  onOpenNext,
}: {
  enabled: boolean
  onToggleViewed: () => void
  onOpenNext: () => void
}) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent): void {
      // Option only — not Cmd (metaKey), and no other modifier riding along.
      if (!event.altKey || event.metaKey || event.ctrlKey) return

      // Match the PHYSICAL key, not event.key: on macOS Option+digit composes a
      // character (Option+1 → "¡"), so event.key never equals "1" with altKey down.
      if (event.code !== "Digit1" && event.code !== "Digit2") return

      // Never hijack a keystroke meant for a text field.
      if (isEditableTarget(event.target)) return

      // Stop the webview from interpreting the chord itself.
      event.preventDefault()

      if (event.code === "Digit1") onToggleViewed()
      else onOpenNext()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, onToggleViewed, onOpenNext])
}
