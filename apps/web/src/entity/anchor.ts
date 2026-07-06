// Symbol navigation view-models (docs/architecture.md §10). Built from
// AnalysisResult.occurrences — the single data source for def <-> usage navigation.

export type OccurrenceRef = {
  path: string
  line: number // head version
}

export type SymbolAnchor = {
  symbolId: string
  name: string // the identifier text, used to locate the token within the line
  role: "definition" | "usage"
  line: number // head line this anchor sits on

  // Dotted underline appears ONLY when the counterpart exists in the PR (§10):
  // a usage with a definition, or a definition with >= 1 usage. No underline =
  // nothing to navigate to; the UI never dead-ends.
  hasCounterpart: boolean

  // For a usage: where its definition lives (peek/jump target). Null for a definition.
  definition: OccurrenceRef | null

  // For a definition: every usage in the PR (the "N usages" pill). Empty for a usage.
  usages: OccurrenceRef[]
}

// path -> head line -> anchors on that line. Empty inner map means "nothing to underline".
export type AnchorIndex = Map<string, Map<number, SymbolAnchor[]>>
