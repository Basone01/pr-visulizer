import type { AnalysisResult } from "@pr-visulizer/shared"

import type { PrTarget } from "../githubGateway/index.js"

// Two engines, one contract (docs/architecture.md §4). Both emit the same
// `AnalysisResult`, so the graph UI, ranking, and review flow are engine-blind.
// The fast engine (§5) is implemented here; the deep engine (§6) slots in later
// behind this exact interface — nothing upstream changes when it lands.

// Progressive analysis (docs/architecture.md §5/§6). The engine reports which phase it is in
// and, for a counted phase, how far through it is — so the UI can render a live step list
// ("reading files 7/23") instead of a static "Loading…". These are ENGINE-side signals: the
// wire `AnalysisResult` contract (§3) is untouched, and the BFF simply ignores `options`
// (the extra arg is optional, so its `engine.analyze(target)` call still type-checks).
export type AnalysisStep =
  | "fetching-pr"
  | "reading-files"
  | "parsing"
  | "resolving"
  | "ranking"
  // deep-v2 only: the compiler-grade pass that confirms/adds `source:'lsp'` edges (§6.2).
  | "precise-linking"

export type AnalysisProgress = {
  step: AnalysisStep
  done?: number
  total?: number
}

export type AnalysisProgressFn = (progress: AnalysisProgress) => void

export type AnalyzeOptions = {
  onProgress?: AnalysisProgressFn
}

export interface AnalysisEngine {
  readonly name: AnalysisResult["engine"]

  // Keyed by (owner, repo, prNumber, headSha, name) — immutable per key (§4, §5 step 9).
  // `options.onProgress` is optional; a caller that ignores progress omits it entirely.
  analyze(target: PrTarget, options?: AnalyzeOptions): Promise<AnalysisResult>
}

export type { PrTarget }
