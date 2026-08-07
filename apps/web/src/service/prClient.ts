import type {
  AnalysisResult,
  CommitRange,
  DraftComment,
  PrCommitList,
  PrOverview,
  PrSummary,
  RangeDiff,
  ReviewComment,
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
  // The PR's commits, for the diff pane's commit-range picker (§10). Whole-PR and read-only —
  // picking a range narrows the DIFF only; ranking, the graph and the queue stay whole-PR.
  listCommits(target: PrTarget): Promise<PrCommitList>
  // The diff restricted to one commit range. ONE call carries every file in the range, so the
  // open file's patch and the set of touched paths both come from this single result.
  getRangeDiff(target: PrTarget, range: CommitRange): Promise<RangeDiff>
  // One file's WHOLE content at the PR's head revision — the full-file diff view (§10). null
  // means "no head content for this file here" (a deleted file, a binary blob, or a client that
  // can't reconstruct it); the toolbar falls back to the hunks-only view and says so.
  getFileAtHead(target: PrTarget, path: string): Promise<string | null>
  getProgress(target: PrTarget): Promise<ReviewProgress>
  putProgress(target: PrTarget, progress: ReviewProgress): Promise<ReviewProgress>
  submitReview(target: PrTarget, submission: ReviewSubmission): Promise<void>
  // §11: publish one inline comment immediately — no pending review, visible at once.
  addCommentNow(target: PrTarget, comment: DraftComment): Promise<void>
  // Every EXISTING published review comment on the PR (any author) — the "show existing comments"
  // feature. Read-only; the SPA groups them into threads and anchors each to its head line.
  listReviewComments(target: PrTarget): Promise<ReviewComment[]>
  // Edit the body of ONE own published comment (§11). Answers void on purpose: the refetched
  // comment list is the source of truth for what the thread now says, so no caller has to
  // reconcile a returned row against the list it is already reading.
  updateReviewComment(target: PrTarget, commentId: number, body: string): Promise<void>
  // The authenticated viewer identity (§9 /api/me): http → the BFF route, tauri → the
  // gateway, fixture → a dev viewer. Powers the own-PR Approve guard (task 4, §11).
  getViewer(): Promise<Viewer>
  // The home-screen picker (docs/tauri-architecture.md §5): open PRs for a watched repo.
  // http → new BFF route; fixture/tauri → gateway or fixture direct.
  listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]>
  // Drop everything this client (or the BFF behind it) has memoized about ONE PR, so the next
  // read sees the PR at its current head. The refresh button calls this BEFORE invalidating the
  // query cache: both sides memoize per PR with no head SHA in the key — the BFF's analysis job
  // and the desktop client's PR meta / prepared repo — so invalidating queries alone would
  // refetch straight back into the pre-push answer.
  invalidatePr(target: PrTarget): Promise<void>
}
