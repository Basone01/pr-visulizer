import type { ChangedSymbol } from "@pr-visulizer/shared"

import { headHunkRanges, rangesIntersect } from "../../utils/diffHunks.js"
import type { GatewayChangedFile } from "../githubGateway/index.js"
import type { ModuleSymbol, ModuleSyntax } from "./treeSitter.js"

// Turning extracted symbols into the §3 ChangedSymbol set — the same rules the fast
// engine applies (§5 step 5), factored out so the deep engine reuses them verbatim. Pure
// functions over plain data; the fast engine keeps its own inlined copies unchanged.

// Which symbols in a file count as changed, and how. Added/deleted files change ALL their
// symbols; a modified/renamed file changes only symbols whose span intersects a head hunk.
export function symbolChangeKind(
  file: GatewayChangedFile
): (symbol: ModuleSymbol) => ChangedSymbol["changeKind"] | null {
  if (file.status === "added") return () => "added"
  if (file.status === "deleted") return () => "deleted"

  const hunks = headHunkRanges(file.patch)
  return (symbol) => {
    const touched = hunks.some((hunk) =>
      rangesIntersect(hunk, { startLine: symbol.startLine, endLine: symbol.endLine })
    )
    return touched ? "modified" : null
  }
}

export type ChangedFileSyntax = {
  file: GatewayChangedFile
  syntax: ModuleSyntax
}

export type ChangedSymbolIndex = {
  symbols: ChangedSymbol[]
  byId: Map<string, ChangedSymbol>
  byPath: Map<string, ChangedSymbol[]>
}

// Build the changed-symbol set plus id/path indexes for edge + occurrence resolution.
export function buildChangedSymbols(parsed: ChangedFileSyntax[]): ChangedSymbolIndex {
  const symbols: ChangedSymbol[] = []
  const byId = new Map<string, ChangedSymbol>()
  const byPath = new Map<string, ChangedSymbol[]>()

  for (const { file, syntax } of parsed) {
    const changeKindOf = symbolChangeKind(file)
    const bucket: ChangedSymbol[] = []

    for (const raw of syntax.symbols) {
      const changeKind = changeKindOf(raw)
      if (!changeKind) continue

      const symbol: ChangedSymbol = {
        id: `${file.path}#${raw.name}`,
        path: file.path,
        name: raw.name,
        kind: raw.kind,
        span: { startLine: raw.startLine, endLine: raw.endLine },
        changeKind,
      }

      symbols.push(symbol)
      byId.set(symbol.id, symbol)
      bucket.push(symbol)
    }

    byPath.set(file.path, bucket)
  }

  return { symbols, byId, byPath }
}

// The innermost changed symbol whose span contains a line (a method wins over its
// enclosing class) — attributes a reference to the symbol whose body it sits in (§7).
export function innermostContaining(symbols: ChangedSymbol[], line: number): ChangedSymbol | null {
  let best: ChangedSymbol | null = null

  for (const symbol of symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue

    const span = symbol.span.endLine - symbol.span.startLine
    if (!best || span < best.span.endLine - best.span.startLine) best = symbol
  }

  return best
}
