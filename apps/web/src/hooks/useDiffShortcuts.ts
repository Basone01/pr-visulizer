import { useEffect } from "react"

import { isEditableTarget } from "@/utils/dom/isEditableTarget"

// Keyboard shortcuts for the open diff (user picked Ctrl deliberately, not Cmd):
//   Ctrl+1 → toggle mark-viewed on the open file
//   Ctrl+2 → open the next suggested file
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
      // Ctrl only — not Cmd (metaKey), and no other modifier riding along.
      if (!event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== "1" && event.key !== "2") return

      // Never hijack a keystroke meant for a text field.
      if (isEditableTarget(event.target)) return

      // Stop the webview from interpreting the chord itself.
      event.preventDefault()

      if (event.key === "1") onToggleViewed()
      else onOpenNext()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, onToggleViewed, onOpenNext])
}
