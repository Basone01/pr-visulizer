// View-model types for the diff panel (docs/architecture.md §10). Derived from the
// unified diff; the shared contract owns the wire types, these own the render shape.

export type DiffLineKind = "add" | "del" | "context" | "hunk"

export type DiffLine = {
  kind: DiffLineKind
  // The line text without its leading +/-/space marker. For a hunk row, the header.
  content: string
  // Line number in the base version (LEFT gutter); null for added lines and headers.
  oldLine: number | null
  // Line number in the head version (RIGHT gutter); null for deleted lines and headers.
  // Symbol occurrences (§10) are keyed by head line, so this is the anchor key.
  newLine: number | null
}

export type ParsedDiff = {
  lines: DiffLine[]
}
