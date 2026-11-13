import type {
  ChangedFile,
  ChangedFileFacts,
  OmissionReason,
  SkipReason,
} from "@pr-visulizer/shared"

// Render-shape view-models derived from the AnalysisResult + live review progress.
// The wire contract stays in @pr-visulizer/shared; these are the SPA's own shapes.

export type FileStatus = ChangedFile["status"]

export type TrayRow = {
  path: string
  // 1-based static order (from AnalysisResult.ranking). null for a skipped file: no rank.
  order: number | null
  // "generated" when the review leaves this file out of the analysis and the ranking, or null.
  skipReason: SkipReason | null
  // Why this file's diff cannot be shown, or null. The file itself stays in the review.
  diffOmitted: OmissionReason | null
  status: FileStatus
  churn: number // additions + deletions — shown before analysis lands (task 4)
  reviewed: boolean
  // Live readiness, recomputed after every checkmark (§8.2). null = analysis not ready yet
  // (the overview has no ranking), rendered as "…" in the chip (task 4 progressive shell).
  readiness: number | null
  isNext: boolean // the single suggested-next file
  blastRadius: number | null // deep engine only — a risk badge
  draftCount: number // inline draft comments saved on this file (task 5 badge)
}

export type FileNodeVM = {
  path: string
  fileName: string // basename shown on the node
  status: FileStatus
  order: number
  topoLevel: number // maps 1:1 to the layout column (§2.1)
  additions: number
  deletions: number
  fanIn: number
  blastRadius: number | null
  symbols: string[] // changed-symbol names, shown as chips
  reviewed: boolean
  isNext: boolean
}

export type GhostNodeVM = {
  path: string
  fileName: string
  usedChangedSymbols: string[]
  // The changed files this ghost reaches — one faded graph edge each (§6, §380).
  usesChangedFiles: string[]
}

// Which optional rows a FileNode renders. The single predicate shared by the node itself (what it
// draws) and by the graph layout (the height it reserves), so the reserved box and the rendered
// box always agree — a blast-radius badge only shows when something unchanged depends on the file.
export function fileNodeVariant(vm: FileNodeVM): { hasSymbols: boolean; hasBlast: boolean } {
  return {
    hasSymbols: vm.symbols.length > 0,
    hasBlast: vm.blastRadius !== null && vm.blastRadius > 0,
  }
}

export type PrView = {
  trayRows: TrayRow[]
  fileNodes: FileNodeVM[]
  ghostNodes: GhostNodeVM[]
  suggestedPath: string | null
  // Completion counts reviewable files only: a generated file needs no review.
  reviewedCount: number
  totalCount: number
  allReviewed: boolean
  // Generated files listed in the queue but not counted above.
  generatedCount: number
  // The analysis's two facts per changed file. Null until the analysis lands.
  factsByPath: ReadonlyMap<string, ChangedFileFacts> | null
}
