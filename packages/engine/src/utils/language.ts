import { extname } from "./posixPath.js"

// Map a repo path to the tree-sitter grammar id, or null when we ship no grammar
// for it (docs/architecture.md §5: "null = heuristic mode"). TS/TSX, JS/JSX and Go
// are shipped; every other extension falls back to the import-regex heuristic (a
// grey node that still ranks).
//
// Each grammar id names a wasm the platform's GrammarSource must yield: node reads
// `tree-sitter-<id>.wasm` off disk from tree-sitter-wasms (verified present:
// go, javascript, typescript and tsx all ship in the installed 0.1.13).
//
// `.jsx` maps to `javascript`, not `tsx`: verified by parsing a JSX sample with each
// grammar — `javascript` reads jsx_element with no error, while `typescript` errors on
// it (which is why `.tsx` needs the separate `tsx` grammar).

const GRAMMAR_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".go": "go",
}

export function languageForPath(path: string): string | null {
  return GRAMMAR_BY_EXTENSION[extname(path)] ?? null
}

// Every grammar id `languageForPath` can return. A platform's GrammarSource MUST be able to
// yield a wasm for each one, or a repo containing that extension fails to analyse — the webview
// loader bundles its assets by hand, so it has a coverage test that reads this list.
export const SUPPORTED_GRAMMAR_IDS: readonly string[] = [
  ...new Set(Object.values(GRAMMAR_BY_EXTENSION)),
].sort()

// Is this a file the TypeScript compiler can hold in a program? The deep-v2 precision tier is
// TS/JS-only: asking its LanguageService about a Go path throws `Could not find source file`,
// which used to abort the ENTIRE query batch and silently degrade the whole tier.
export function isTypeScriptFamily(path: string): boolean {
  const grammar = languageForPath(path)
  return grammar !== null && grammar !== "go"
}

// The RESOLUTION family a grammar belongs to. Name resolution never crosses it: a Go file can
// only reference Go symbols, a TS/JS file only TS/JS ones (deepResolve splits on exactly this).
// So a PR that changed no TS file gains nothing from parsing the repo's TypeScript — and
// parsing it is ruinously expensive: measured, the TS-family tree-sitter grammars retain
// ~3.9 MB of wasm heap PER FILE that is never reclaimed, against 25 KB/file for Go.
export type GrammarFamily = "go" | "ts"

export function familyOfGrammar(grammarId: string): GrammarFamily {
  return grammarId === "go" ? "go" : "ts"
}

// The families a changed-file set can possibly resolve within. Empty when nothing parseable
// changed — then the repo-wide index has nothing to serve and no file need be parsed.
export function familiesOfPaths(paths: Iterable<string>): Set<GrammarFamily> {
  const families = new Set<GrammarFamily>()
  for (const path of paths) {
    const grammar = languageForPath(path)
    if (grammar !== null) families.add(familyOfGrammar(grammar))
  }

  return families
}
