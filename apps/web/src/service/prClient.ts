import type { AnalysisResult, DraftComment, ReviewProgress } from "@pr-visulizer/shared"

import type { Engine, PrTarget } from "@/entity/pr"

// The BFF boundary as a narrow interface (docs/architecture.md §9). App code depends
// on PrClient, never on fetch or a fixture directly, so the two are interchangeable —
// the real HTTP client when the BFF lands, the fixture client until then.

// Analysis is 202-then-poll: the BFF returns the result when ready, or "analyzing"
// while the engine runs (§9). The union makes the polling state explicit.
export type AnalysisResponse = { status: "ready"; result: AnalysisResult } | { status: "analyzing" }

export type ReviewSubmission = {
  verdict: NonNullable<ReviewProgress["verdict"]>
  body: string
  comments: DraftComment[]
}

export interface PrClient {
  getAnalysis(target: PrTarget, engine: Engine): Promise<AnalysisResponse>
  getPatch(target: PrTarget, path: string): Promise<string>
  getProgress(target: PrTarget): Promise<ReviewProgress>
  putProgress(target: PrTarget, progress: ReviewProgress): Promise<ReviewProgress>
  submitReview(target: PrTarget, submission: ReviewSubmission): Promise<void>
  deepen(target: PrTarget): Promise<void>
}
