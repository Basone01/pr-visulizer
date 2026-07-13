// True when an event target is a text-entry surface (input / textarea / select / contenteditable).
// Keyboard shortcuts consult this so they never steal a keystroke the user meant for a field —
// e.g. the comment composer or the find-in-file input.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true

  return target.isContentEditable
}
