import type {
  AnalysisResult,
  CommitRange,
  DraftComment,
  FileHistory,
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

// A patch snapshot is usable for AI context only when the client verifies that every returned
// patch belongs to these exact PR revisions both before and after collection. Callers cannot
// combine lazy, revision-unknown diff reads into a prompt.
export type RevisionPinnedPatchSnapshot = {
  baseSha: string
  headSha: string
  patches: Record<string, string>
}

export type RevisionPinnedPatchSnapshotRequest = {
  baseSha: string
  headSha: string
  paths: readonly string[]
}

// Why a tagged error rather than prose: the bounded AI assembler must decide between "abort the
// whole assembly" and "disclose this one path as omitted", and every revision-pinned reader must
// mean the same thing by that decision. Matching each other's message text let the two sides
// drift silently — a reader reworded to "patch too large" would have been disclosed as merely
// unavailable, understating the omission. The reason is the contract; the message is only prose.
export type RevisionPinnedPatchFailureReason =
  // A PR revision moved between the reads, so old and new context would be mixed. Fail closed.
  | "revision-changed"
  // A body was refused on bytes before it was decoded or parsed into a patch string.
  | "patch-byte-limit"
  // No bounded reader answered for this path (no repo source, no local base, no diff).
  | "patch-unavailable"

// Both revision checks a reader performs — PR identity before/after collection, and the returned
// snapshot's own revisions — carry these exact messages, so a rejection still reads plainly.
export const REVISION_PINNED_PR_REVISION_CHANGED_MESSAGE =
  "PR revisions changed while collecting the revision-pinned patch snapshot"
export const REVISION_PINNED_SNAPSHOT_REVISION_MISMATCH_MESSAGE =
  "Patch snapshot revisions do not match the admitted review revisions"

// The Rust `repo_file_diff` cap (apps/desktop/src-tauri/src/lib.rs) refuses over-limit bytes
// before UTF-8 conversion and crosses the Tauri invoke boundary as this bare string, never as an
// Error, so an untagged refusal still has to be recognized once. This is the ONLY place on the
// TypeScript side that reads that text — no caller matches Rust's prose.
const BOUNDED_PATCH_BYTE_LIMIT_MARKER = "bounded patch byte limit"

export class RevisionPinnedPatchError extends Error {
  readonly reason: RevisionPinnedPatchFailureReason

  constructor(reason: RevisionPinnedPatchFailureReason, message: string) {
    super(message)
    this.name = "RevisionPinnedPatchError"
    this.reason = reason
  }
}

// Normalize whatever a reader rejected with into the tagged contract. An already-tagged error is
// returned untouched; a bare invoke string or an untagged Error is classified once, here.
export function toRevisionPinnedPatchError(error: unknown): RevisionPinnedPatchError {
  if (error instanceof RevisionPinnedPatchError) return error

  const message = error instanceof Error ? error.message : String(error)
  const reason: RevisionPinnedPatchFailureReason = message.includes(BOUNDED_PATCH_BYTE_LIMIT_MARKER)
    ? "patch-byte-limit"
    : "patch-unavailable"

  return new RevisionPinnedPatchError(reason, message)
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
  // Collect an all-or-nothing patch snapshot at explicit displayed PR revisions. This is the
  // only patch seam permitted to assemble AI review context or revalidate an AI draft anchor.
  getRevisionPinnedPatchSnapshot(
    target: PrTarget,
    request: RevisionPinnedPatchSnapshotRequest
  ): Promise<RevisionPinnedPatchSnapshot>
  // The PR's commits, for the diff pane's commit-range picker (§10). Whole-PR and read-only —
  // picking a range narrows the DIFF only; ranking, the graph and the queue stay whole-PR.
  listCommits(target: PrTarget): Promise<PrCommitList>
  // The diff restricted to one commit range. ONE call carries every file in the range, so the
  // open file's patch and the set of touched paths both come from this single result.
  getRangeDiff(target: PrTarget, range: CommitRange): Promise<RangeDiff>
  // The PR commits that touched one file, oldest-first, for the file history lens (§10). Each
  // entry is a full PrCommit, so a history step is a single-commit range with no second lookup.
  getFileHistory(target: PrTarget, path: string): Promise<FileHistory>
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
