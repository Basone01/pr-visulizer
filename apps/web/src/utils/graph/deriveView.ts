import {
  type AnalysisResult,
  type ChangedSymbol,
  type DraftComment,
  type PrOverview,
  type QueueMode,
  type RankedFile,
  type RankingInput,
  rankFiles,
  rankingPolicyForQueueMode,
  readiness,
  suggestNext,
  suggestNextInOrder,
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

// The tray/graph order for the chosen queue mode. "foundations" reuses the engine's
// precomputed ranking as-is; "branch" re-ranks the same files+edges client-side with the
// branch-traversal policy (§8.4), carrying blastRadius through so ghost math is unchanged.
// Re-ranking client-side is cheap (≤ 300 files) and keeps mode-switching instant.
function orderedRanksForMode(analysis: AnalysisResult, mode: QueueMode): RankedFile[] {
  if (mode !== "branch") return [...analysis.ranking].sort((a, b) => a.order - b.order)

  const blastByPath = new Map(analysis.ranking.map((ranked) => [ranked.path, ranked.blastRadius]))
  const input: RankingInput = {
    files: analysis.files.map((file) => {
      const churn = file.additions + file.deletions
      const blastRadius = blastByPath.get(file.path)

      return blastRadius !== undefined
        ? { path: file.path, churn, blastRadius }
        : { path: file.path, churn }
    }),
    edges: analysis.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  }

  return rankFiles(input, rankingPolicyForQueueMode("branch"))
}

function draftCountByPath(drafts: DraftComment[]): Map<string, number> {
  const counts = new Map<string, number>()

  for (const draft of drafts) {
    counts.set(draft.path, (counts.get(draft.path) ?? 0) + 1)
  }

  return counts
}

export function derivePrView(
  analysis: AnalysisResult,
  reviewedFiles: string[],
  drafts: DraftComment[] = [],
  queueMode: QueueMode = "foundations"
): PrView {
  const reviewed = new Set(reviewedFiles)
  const draftCounts = draftCountByPath(drafts)

  // The ranking graph (changed files only, file-level edges) drives the live math. `readiness`
  // is a per-file fact ("do I have full context for this one?"), so it is queue-mode-independent
  // and every row shows it.
  const graph = toDependencyGraph(analysis.files, analysis.edges)
  const readinessByPath = readiness(graph, reviewed)

  const fileByPath = new Map(analysis.files.map((file) => [file.path, file]))
  const symbolsByPath = symbolNamesByPath(analysis.symbols)

  // Tray + graph both walk the SAME ordered list so the two panes agree row-for-node — the
  // chosen queue mode decides that order.
  const orderedRanks = orderedRanksForMode(analysis, queueMode)

  // The SUGGESTION must speak the same language as the order the user chose (§8.4).
  // - foundations: the §8.2 readiness pick — "what has full context right now".
  // - branch: the first unreviewed file in the branch order, so the highlight stays inside the
  //   current dependency chain until it is exhausted. A readiness pick would hop between
  //   disjoint chains, since every chain's foundation scores 1.0 (the PR #1087 report).
  const suggestedPath =
    queueMode === "branch"
      ? suggestNextInOrder(
          orderedRanks.map((ranked) => ranked.path),
          reviewed
        )
      : suggestNext(graph, reviewed)

  const trayRows: TrayRow[] = orderedRanks.map((ranked) => {
    const file = fileByPath.get(ranked.path)!

    return {
      path: ranked.path,
      order: ranked.order,
      status: file.status,
      churn: file.additions + file.deletions,
      reviewed: reviewed.has(ranked.path),
      readiness: readinessByPath.get(ranked.path) ?? 1,
      isNext: ranked.path === suggestedPath,
      blastRadius: blastRadiusOf(ranked),
      draftCount: draftCounts.get(ranked.path) ?? 0,
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

// The PROVISIONAL view derived from the overview alone, before analysis lands (task 4). The
// tray rows carry path + churn + the live checkbox, but readiness is null ("…" in the chip)
// and there is no ranking, graph, or suggestion yet — those fill in when derivePrView runs on
// the full result. Kept beside derivePrView so both produce one PrView shape the tray renders.
export function deriveOverview(
  overview: PrOverview,
  reviewedFiles: string[],
  drafts: DraftComment[] = []
): PrView {
  const reviewed = new Set(reviewedFiles)
  const draftCounts = draftCountByPath(drafts)

  const trayRows: TrayRow[] = overview.files.map((file, index) => ({
    path: file.path,
    order: index + 1, // file-list order until the ranking replaces it
    status: file.status,
    churn: file.additions + file.deletions,
    reviewed: reviewed.has(file.path),
    readiness: null, // unknown until ranking exists → "…" chip
    isNext: false,
    blastRadius: null,
    draftCount: draftCounts.get(file.path) ?? 0,
  }))

  return {
    trayRows,
    fileNodes: [],
    ghostNodes: [],
    suggestedPath: null,
    reviewedCount: overview.files.filter((file) => reviewed.has(file.path)).length,
    totalCount: overview.files.length,
    allReviewed:
      overview.files.length > 0 && overview.files.every((file) => reviewed.has(file.path)),
  }
}
