import type { Edge } from "@pr-visulizer/shared"

// The precision tier's boundary (docs/architecture.md §4.2, §6.2 deep-v2). Defined by its
// CONSUMER — the merge below — not by its implementation, so the merge logic can be tested
// with a hand-written fake and never sees `typescript`. The real implementation
// (`tsLanguageService.ts`) is the only module that imports the compiler.

// One reference site found by a language service: `path`:`line` refers to the changed symbol
// `symbolId`. `kind` is how it is used there — the same vocabulary as an Edge.
export type PreciseReference = {
  symbolId: string // the changed symbol being referenced (`${path}#${name}`)
  path: string // file the reference sits in (may be unchanged — a ghost)
  line: number // 1-based
  kind: Extract<Edge["kind"], "calls" | "uses" | "uses-type">
}

// Repo-wide, compiler-grade references to the given changed symbols. Bounded by the caller
// (a cap on symbols, a deadline) — the index itself makes no promises about cost.
export interface PreciseReferenceIndex {
  referencesTo(symbolIds: readonly string[]): Promise<PreciseReference[]>
}

// The in-memory fake: the merge's tests drive THIS, so a failing merge test can never be
// blamed on a language service. Returns exactly what it was handed, filtered to the query.
export function createFakeReferenceIndex(
  references: readonly PreciseReference[]
): PreciseReferenceIndex {
  return {
    referencesTo(symbolIds) {
      const wanted = new Set(symbolIds)
      return Promise.resolve(references.filter((reference) => wanted.has(reference.symbolId)))
    },
  }
}
