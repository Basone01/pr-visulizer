import type { AnalysisResult } from "@pr-visulizer/shared"

import type { PrTarget } from "../githubGateway/index.js"

// Two engines, one contract (docs/architecture.md §4). Both emit the same
// `AnalysisResult`, so the graph UI, ranking, and review flow are engine-blind.
// The fast engine (§5) is implemented here; the deep engine (§6) slots in later
// behind this exact interface — nothing upstream changes when it lands.
export interface AnalysisEngine {
  readonly name: AnalysisResult["engine"]

  // Keyed by (owner, repo, prNumber, headSha, name) — immutable per key (§4, §5 step 9).
  analyze(target: PrTarget): Promise<AnalysisResult>
}

export type { PrTarget }
