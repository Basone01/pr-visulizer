import type { ChangedFile } from "@pr-visulizer/shared"

// Render-shape view-models derived from the AnalysisResult + live review progress.
// The wire contract stays in @pr-visulizer/shared; these are the SPA's own shapes.

export type FileStatus = ChangedFile["status"]

export type TrayRow = {
  path: string
  order: number // 1-based static order (from AnalysisResult.ranking)
  status: FileStatus
  reviewed: boolean
  readiness: number // live, recomputed after every checkmark (§8.2)
  isNext: boolean // the single suggested-next file
  blastRadius: number | null // deep engine only — a risk badge
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
}

export type PrView = {
  trayRows: TrayRow[]
  fileNodes: FileNodeVM[]
  ghostNodes: GhostNodeVM[]
  suggestedPath: string | null
  reviewedCount: number
  totalCount: number
  allReviewed: boolean
}
