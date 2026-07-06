import type { ChangedFile, DraftComment, PrMeta } from "@pr-visulizer/shared"

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

export type ReviewCommentInput = Pick<DraftComment, "path" | "line" | "side" | "body">

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

export interface GithubGateway {
  // §5 step 1–2: PR meta + changed-file list with patches.
  getPullRequest(target: PrTarget): Promise<PullRequestData>

  // §5 step 3: full file content at a SHA (head or base) for parsing + the diff view.
  getFileContent(target: PrTarget, path: string, sha: string): Promise<string>

  // §11: the real GitHub review (approve / request-changes / comment).
  submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult>

  // §11: GitHub's native "Viewed" checkbox (GraphQL markFileAsViewed), synced on
  // every progress write so app checkmarks show up in the GitHub UI too.
  markFileAsViewed(target: PrTarget, path: string): Promise<void>

  // Current authenticated user (powers /api/me).
  getViewer(): Promise<SessionUser>
}
