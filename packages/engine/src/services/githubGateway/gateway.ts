import type {
  ChangedFile,
  DraftComment,
  FileHistory,
  FileOmission,
  PrCommit,
  PrCommitList,
  PrMeta,
  PrSummary,
  RangeDiff,
  RangeDiffFile,
  ReviewComment,
  SkippedFile,
} from "@pr-visulizer/shared"

import type { SessionUser } from "../../entities/index.js"

// The ONE GitHub seam (docs/architecture.md §2). Everything upstream — the analysis
// engine, the review service, the routes — depends on THIS interface, never on
// Octokit. Real (Octokit) and fake (fixture) implementations are swapped in one
// place, so the SPA never talks to api.github.com and the token stays server-side.

export type PrTarget = {
  owner: string
  repo: string
  number: number
}

// A repository without a specific PR — the home screen's open-PR picker works at this
// level (docs/tauri-architecture.md §5).
export type RepoRef = {
  owner: string
  repo: string
}

// A changed file plus its unified-diff patch (§5 steps 1–2). `patch` is null for
// files GitHub omits a diff for (binary, too large, pure rename).
export type GatewayChangedFile = ChangedFile & {
  patch: string | null
  // Set when the reader found the file generated. The engine lists it in
  // AnalysisResult.skipped and never ranks it.
  skip?: SkippedFile
  // Parts of the file the reader could not read (its diff, its content). The file is still
  // analysed and ranked; the engine passes these through to AnalysisResult.omitted.
  omissions?: FileOmission[]
}

export type PullRequestData = {
  pr: PrMeta
  files: GatewayChangedFile[]
}

// One commit of a FIXTURE PR (§10): the picker row's data plus the per-file changes that commit
// contributed. The fake gateway unions the files of the commits inside a range to answer a
// compare, so a fixture range diff is derived the way a real one is rather than hard-coded per
// range — which keeps the fixture honest as commits are added to it.
export type GatewayFixtureCommit = PrCommit & {
  files: RangeDiffFile[]
}

// GitHub review verdicts (§11). Mapped from the app-side `verdict` in the review service.
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

export type ReviewCommentInput = Pick<DraftComment, "path" | "line" | "startLine" | "side" | "body">

export type SubmitReviewInput = {
  target: PrTarget
  commitId: string // headSha — anchors the review to the reviewed commit (§11)
  event: ReviewEvent
  body: string
  comments: ReviewCommentInput[]
}

export type SubmitReviewResult = {
  reviewId: number
}

// GitHub's own per-file "Viewed" checkbox (§11). Verified 2026-07 against the live GraphQL
// schema: `FileViewedState` is exactly these three values, and DISMISSED means "was viewed,
// then the file changed" — which is NOT viewed for our purposes.
export type ViewedFileState = "VIEWED" | "UNVIEWED" | "DISMISSED"

// §11: one comment published immediately (not part of a pending review). Same shape as a
// review's inline comment, anchored to the reviewed commit.
export type AddReviewCommentInput = {
  target: PrTarget
  commitId: string // headSha
  comment: ReviewCommentInput
}

// §11: edit the BODY of one already-published review comment. Only the body is editable —
// GitHub's PATCH /pulls/comments/:id takes nothing else, and re-anchoring a published comment
// to another line is not an edit, it is a different comment.
export type UpdateReviewCommentInput = {
  target: PrTarget
  commentId: number
  body: string
}

export interface GithubGateway {
  // PR meta ONLY — one light `GET /pulls/:n` (no file pagination). The desktop deep path
  // (docs/tauri-architecture.md §6) uses this instead of getPullRequest: file list + patches
  // come from local git, so the API never paginates listFiles-with-patches for it.
  getPullMeta(target: PrTarget): Promise<PrMeta>

  // §5 step 1–2: PR meta + changed-file list with patches (the BFF/http path).
  getPullRequest(target: PrTarget): Promise<PullRequestData>

  // Home-screen picker (docs/tauri-architecture.md §5): open PRs for a repo, newest-
  // updated first. GET /repos/:owner/:repo/pulls?state=open — one Octokit call.
  listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]>

  // §5 step 3: full file content at a SHA (head or base) for parsing + the diff view.
  getFileContent(target: PrTarget, path: string, sha: string): Promise<string>

  // §10 commit-range selection: the PR's commits, for the diff pane's range picker. GitHub
  // caps this at 250 commits, so the result carries a `truncated` flag rather than pretending
  // the list is complete.
  listPrCommits(target: PrTarget): Promise<PrCommitList>

  // §10: the diff restricted to one commit range — the three-dot compare of baseSha...headSha.
  // The caller derives `baseSha` from the first selected commit's first parent (see
  // `commitRange` in the shared contract), never from git rev syntax like `sha^`.
  compareRange(target: PrTarget, baseSha: string, headSha: string): Promise<RangeDiff>

  // §10 file history: the PR commits that touched `path`, oldest-first in PR order. Commits
  // outside the PR never appear. A path renamed inside the PR lists only the commits made under
  // its current name (a documented limitation, the commits endpoint does not follow renames).
  listPrCommitsForPath(target: PrTarget, path: string): Promise<FileHistory>

  // §11: the real GitHub review (approve / request-changes / comment).
  submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult>

  // §11: publish ONE inline comment immediately — POST /pulls/:n/comments, visible at once,
  // no pending review involved.
  addReviewComment(input: AddReviewCommentInput): Promise<void>

  // READ every EXISTING published review comment on the PR (any author) — the "show existing
  // comments" feature. GET /pulls/:n/comments, paginated. Read-only: this pass views threads,
  // it never replies/edits/resolves. Rows are mapped to the shared ReviewComment shape.
  listReviewComments(target: PrTarget): Promise<ReviewComment[]>

  // §11: EDIT one own published review comment — PATCH /pulls/comments/:id. GitHub is the
  // authority on who may edit (it answers 403 for someone else's comment); the app only gates
  // the affordance. Answers with the updated comment, the same shape the list read returns.
  updateReviewComment(input: UpdateReviewCommentInput): Promise<ReviewComment>

  // §11: READ GitHub's native "Viewed" checkboxes for this reviewer, path → state. The
  // sync is two-way — a file ticked on github.com has to show up here too — so the state
  // has to be readable, not just writable. GraphQL only: the REST changed-files route
  // carries no viewed state at all (verified against the live schema, 2026-07).
  listViewedFiles(target: PrTarget): Promise<Record<string, ViewedFileState>>

  // §11: WRITE one file's "Viewed" checkbox — GraphQL markFileAsViewed / unmarkFileAsViewed.
  // Both directions, because un-ticking here must un-tick on GitHub as well.
  setFileViewed(target: PrTarget, path: string, viewed: boolean): Promise<void>

  // Current authenticated user (powers /api/me).
  getViewer(): Promise<SessionUser>
}
