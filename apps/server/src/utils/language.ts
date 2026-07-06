import { posix } from "node:path"

// Map a repo path to the tree-sitter grammar id, or null when we ship no grammar
// for it (docs/architecture.md §5: "null = heuristic mode"). TS/TSX first; every
// other extension — including plain .js in this TS-first MVP — falls back to the
// import-regex heuristic (a grey node that still ranks).

const GRAMMAR_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
}

export function languageForPath(path: string): string | null {
  return GRAMMAR_BY_EXTENSION[posix.extname(path)] ?? null
}
