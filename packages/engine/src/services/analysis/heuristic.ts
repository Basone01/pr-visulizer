import type { ModuleImport } from "./treeSitter.js"

// Fallback for files with no tree-sitter grammar (docs/architecture.md §5:
// "file stays in the graph, edges from import-line regex only"). It can only see
// relative import SPECIFIERS — no symbols, no bindings — so its edges carry
// source:'heuristic' and never produce symbol-level precision.

// EVERY import specifier, relative or bare or aliased. Used by the deep pass to decide which
// files are worth parsing (a text scan is ~free; a wasm parse is not). Resolution — relative vs
// tsconfig alias vs external package — is the resolver's job, not this scanner's.
const ANY_SPECIFIER_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
]

export function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()

  for (const pattern of ANY_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1])
    }
  }

  return [...specifiers]
}

const RELATIVE_SPECIFIER_PATTERNS = [
  /\bfrom\s+["'](\.\.?\/[^"']+)["']/g, // import x from './y'
  /\brequire\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g, // require('./y')
  /\bimport\s+["'](\.\.?\/[^"']+)["']/g, // import './y' (side-effect)
]

export function heuristicImports(source: string): ModuleImport[] {
  const specifiers = new Set<string>()

  for (const pattern of RELATIVE_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1])
    }
  }

  return [...specifiers].map((specifier) => ({ specifier, bindings: [] }))
}
