import type { OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

// Symbol-navigation state (docs/architecture.md §10). The ladder is
// peek -> expand -> jump, each step heavier than the last; only a real jump
// pushes the jump stack. Navigation is a detour, never a context switch — it
// touches nothing in the review queue.

export type NavLocation = {
  path: string
  line: number // head line the diff pane focuses / scrolls to
}

// Head lines, inclusive on both ends.
export type LineSpan = { startLine: number; endLine: number }

export type PeekState = {
  // "definition": a usage was clicked, its definition renders under that usage line.
  // "usage": a usage site was clicked in a definition's "N usages" popover, it renders there.
  kind: "definition" | "usage"
  anchor: SymbolAnchor // the clicked usage, or the definition whose popover is open
  target: OccurrenceRef // the location rendered inline in the popover
  span: LineSpan // the head lines the peek shows
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
  // Click a usage -> peek its definition. The span's length decides truncation vs peekMaxLines.
  | { type: "peekUsage"; anchor: SymbolAnchor; definitionSpan: LineSpan }
  // Click a usage in a definition's "N usages" popover -> peek that usage site in place.
  | { type: "peekUsageSite"; anchor: SymbolAnchor; target: OccurrenceRef }
  | { type: "expandPeek" }
  | { type: "closePeek" }
  // Jump language: "Jump ⏎" from a peek, or ⌘-click bypassing the peek entirely.
  | { type: "jumpToDefinition"; anchor: SymbolAnchor }
  // Jump to a specific usage from the "N usages" popover.
  | { type: "jumpTo"; target: OccurrenceRef }
  | { type: "back" }
  | { type: "escape" }
  | { type: "clearFlash" }
