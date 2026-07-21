import type { ChangedFile, DraftComment, PrMeta, PrSummary } from "@pr-visulizer/shared"

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
}

export type PullRequestData = {
  pr: PrMeta
  files: GatewayChangedFile[]
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

  // §11: the real GitHub review (approve / request-changes / comment).
  submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult>

  // §11: publish ONE inline comment immediately — POST /pulls/:n/comments, visible at once,
  // no pending review involved.
  addReviewComment(input: AddReviewCommentInput): Promise<void>

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
