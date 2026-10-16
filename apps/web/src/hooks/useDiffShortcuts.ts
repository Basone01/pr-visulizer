import { useEffect } from "react"

import { isEditableTarget } from "@/utils/dom/isEditableTarget"

// Keyboard shortcuts for the open diff (user picked Option deliberately, not Cmd/Ctrl):
//   Option+1 → toggle mark-viewed on the open file
//   Option+2 → open the next suggested file
//   Option+, → file history: step to the older change of this file
//   Option+. → file history: step to the newer change of this file
// One place owns the key→action map so the bindings never drift across scattered listeners.
// Fires only when a file is open and focus is NOT in a text field (composer, find input).
export function useDiffShortcuts({
  enabled,
  onToggleViewed,
  onOpenNext,
  onOlderChange,
  onNewerChange,
}: {
  enabled: boolean
  onToggleViewed: () => void
  onOpenNext: () => void
  onOlderChange: () => void
  onNewerChange: () => void
}) {
  useEffect(() => {
    if (!enabled) return

    // Matched on the PHYSICAL key, not event.key: on macOS Option+key composes a character
    // (Option+1 → "¡", Option+, → "≤"), so event.key never equals the printed key with altKey down.
    const actionByCode: Record<string, () => void> = {
      Digit1: onToggleViewed,
      Digit2: onOpenNext,
      Comma: onOlderChange,
      Period: onNewerChange,
    }

    function onKeyDown(event: KeyboardEvent): void {
      // Option only — not Cmd (metaKey), and no other modifier riding along.
      if (!event.altKey || event.metaKey || event.ctrlKey) return

      const action = actionByCode[event.code]
      if (!action) return

      // Never hijack a keystroke meant for a text field.
      if (isEditableTarget(event.target)) return

      // Stop the webview from interpreting the chord itself.
      event.preventDefault()
      action()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, onToggleViewed, onOpenNext, onOlderChange, onNewerChange])
}
