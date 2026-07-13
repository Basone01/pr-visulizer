import type {
  AnalysisResult,
  DraftComment,
  PrOverview,
  PrSummary,
  ReviewProgress,
  Viewer,
} from "@pr-visulizer/shared"

import type { AnalysisProgressListener } from "@/entity/analysisProgress"
import type { Engine, PrTarget, RepoRef } from "@/entity/pr"

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
  // The instant-open payload (docs/architecture.md §9): PR meta + changed-file list, with no
  // analysis. http → the meta route; fixture + tauri → the gateway direct. The shell renders
  // from this while getAnalysis is still computing (task 4).
  getOverview(target: PrTarget): Promise<PrOverview>
  getAnalysis(target: PrTarget, engine: Engine): Promise<AnalysisResponse>
  // Subscribe to live analysis-step progress for a target (task 5). A queryFn cannot stream,
  // so this is a separate seam: the tauri client feeds it from the in-webview engine callback,
  // the fixture client emits a synthetic sequence, and http mode never emits (202-poll) so its
  // implementation is a no-op. Returns an unsubscribe.
  subscribeAnalysisProgress(target: PrTarget, listener: AnalysisProgressListener): () => void
  getPatch(target: PrTarget, path: string): Promise<string>
  // One file's WHOLE content at the PR's head revision — the full-file diff view (§10). null
  // means "no head content for this file here" (a deleted file, a binary blob, or a client that
  // can't reconstruct it); the toolbar falls back to the hunks-only view and says so.
  getFileAtHead(target: PrTarget, path: string): Promise<string | null>
  getProgress(target: PrTarget): Promise<ReviewProgress>
  putProgress(target: PrTarget, progress: ReviewProgress): Promise<ReviewProgress>
  submitReview(target: PrTarget, submission: ReviewSubmission): Promise<void>
  // The authenticated viewer identity (§9 /api/me): http → the BFF route, tauri → the
  // gateway, fixture → a dev viewer. Powers the own-PR Approve guard (task 4, §11).
  getViewer(): Promise<Viewer>
  // The home-screen picker (docs/tauri-architecture.md §5): open PRs for a watched repo.
  // http → new BFF route; fixture/tauri → gateway or fixture direct.
  listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]>
}
