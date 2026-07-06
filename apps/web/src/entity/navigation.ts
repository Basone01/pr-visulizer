import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

// Symbol-navigation state (docs/architecture.md §10). The ladder is
// peek -> expand -> jump, each step heavier than the last; only a real jump
// pushes the jump stack. Navigation is a detour, never a context switch — it
// touches nothing in the review queue.

export type NavLocation = {
  path: string
  line: number // head line the diff pane focuses / scrolls to
}

export type PeekState = {
  anchor: SymbolAnchor // the usage the reviewer clicked
  target: OccurrenceRef // the definition rendered inline in the popover
  // Long definitions (> peekMaxLines) truncate with a fade until expanded (§10).
  truncated: boolean
  expanded: boolean
}

export type NavState = {
  current: NavLocation // the file + line the diff pane shows
  peek: PeekState | null // open peek popover, or none (peek pushes nothing)
  jumpStack: NavLocation[] // locations jumped FROM; back returns to the top
  flash: NavLocation | null // location to flash-highlight right after a jump
}

export type NavAction =
  // Deliberate context move from the graph / tray — not a detour, clears the stack.
  | { type: "selectFile"; path: string }
  // Click a usage -> peek. definitionLineCount decides truncation vs peekMaxLines.
  | { type: "peekUsage"; anchor: SymbolAnchor; definitionLineCount: number }
  | { type: "expandPeek" }
  | { type: "closePeek" }
  // Jump language: "Jump ⏎" from a peek, or ⌘-click bypassing the peek entirely.
  | { type: "jumpToDefinition"; anchor: SymbolAnchor }
  // Jump to a specific usage from the "N usages" popover.
  | { type: "jumpTo"; target: OccurrenceRef }
  | { type: "back" }
  | { type: "escape" }
  | { type: "clearFlash" }
