import {
  type AnalysisResult,
  type ChangedSymbol,
  type RankedFile,
  readiness,
  suggestNext,
  toDependencyGraph,
} from "@pr-visulizer/shared"

import type { FileNodeVM, GhostNodeVM, PrView, TrayRow } from "@/entity/viewModels"

// Derive every review-view shape from the AnalysisResult + the live reviewed set.
// The ranking core is the single source of truth — readiness/suggestNext come from
// @pr-visulizer/shared, never re-implemented here (docs/architecture.md §8).

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function symbolNamesByPath(symbols: ChangedSymbol[]): Map<string, string[]> {
  const byPath = new Map<string, string[]>()

  for (const symbol of symbols) {
    const names = byPath.get(symbol.path)
    if (names) {
      names.push(symbol.name)
      continue
    }

    byPath.set(symbol.path, [symbol.name])
  }

  return byPath
}

function blastRadiusOf(ranked: RankedFile): number | null {
  return ranked.blastRadius ?? null
}

export function derivePrView(analysis: AnalysisResult, reviewedFiles: string[]): PrView {
  const reviewed = new Set(reviewedFiles)

  // The ranking graph (changed files only, file-level edges) drives the live math.
  const graph = toDependencyGraph(analysis.files, analysis.edges)
  const readinessByPath = readiness(graph, reviewed)
  const suggestedPath = suggestNext(graph, reviewed)

  const rankByPath = new Map(analysis.ranking.map((ranked) => [ranked.path, ranked]))
  const fileByPath = new Map(analysis.files.map((file) => [file.path, file]))
  const symbolsByPath = symbolNamesByPath(analysis.symbols)

  // Tray + graph both walk the static order so the two panes agree row-for-node.
  const orderedRanks = [...analysis.ranking].sort((a, b) => a.order - b.order)

  const trayRows: TrayRow[] = orderedRanks.map((ranked) => {
    const file = fileByPath.get(ranked.path)!

    return {
      path: ranked.path,
      order: ranked.order,
      status: file.status,
      reviewed: reviewed.has(ranked.path),
      readiness: readinessByPath.get(ranked.path) ?? 1,
      isNext: ranked.path === suggestedPath,
      blastRadius: blastRadiusOf(ranked),
    }
  })

  const fileNodes: FileNodeVM[] = orderedRanks.map((ranked) => {
    const file = fileByPath.get(ranked.path)!

    return {
      path: ranked.path,
      fileName: baseName(ranked.path),
      status: file.status,
      order: ranked.order,
      topoLevel: ranked.topoLevel,
      additions: file.additions,
      deletions: file.deletions,
      fanIn: ranked.fanIn,
      blastRadius: blastRadiusOf(ranked),
      symbols: symbolsByPath.get(ranked.path) ?? [],
      reviewed: reviewed.has(ranked.path),
      isNext: ranked.path === suggestedPath,
    }
  })

  // Ghosts are context, never work — empty on the fast engine (§6).
  const ghostNodes: GhostNodeVM[] = analysis.ghosts.map((ghost) => ({
    path: ghost.path,
    fileName: baseName(ghost.path),
    usedChangedSymbols: ghost.usedChangedSymbols,
  }))

  return {
    trayRows,
    fileNodes,
    ghostNodes,
    suggestedPath,
    reviewedCount: analysis.files.filter((file) => reviewed.has(file.path)).length,
    totalCount: analysis.files.length,
    allReviewed: analysis.files.every((file) => reviewed.has(file.path)),
  }
}
