import type { GithubGateway, PrTarget, ReviewEvent, SubmitReviewResult } from "@pr-visulizer/engine"
import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"

// Review-submit flow (docs/architecture.md §11): map the app-side verdict to a GitHub
// review event and post ONE real review, and sync the "Viewed" checkboxes on progress
// writes. Both go through the gateway — the only thing that talks to GitHub.

export type Verdict = NonNullable<ReviewProgress["verdict"]>

export type ReviewSubmission = {
  target: PrTarget
  headSha: string // anchors the review to the reviewed commit (§11 commit_id)
  verdict: Verdict
  body: string
  comments: DraftComment[]
}

const EVENT_BY_VERDICT: Record<Verdict, ReviewEvent> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
}

export type ReviewSubmitService = {
  submit(submission: ReviewSubmission): Promise<SubmitReviewResult>
  syncViewedFiles(target: PrTarget, reviewedFiles: string[]): Promise<void>
}

export function createReviewSubmitService(gateway: GithubGateway): ReviewSubmitService {
  async function submit(submission: ReviewSubmission): Promise<SubmitReviewResult> {
    return gateway.submitReview({
      target: submission.target,
      commitId: submission.headSha,
      event: EVENT_BY_VERDICT[submission.verdict],
      body: submission.body,
      comments: submission.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        // Carry the range start through to the gateway; the octokit impl turns it into
        // GitHub's start_line/start_side, and only for a real multi-line range (§11).
        ...(comment.startLine !== undefined ? { startLine: comment.startLine } : {}),
      })),
    })
  }

  // Called on every progress sync (§11): mirror app checkmarks into GitHub's native
  // "Viewed" state so they show up in the GitHub UI too.
  async function syncViewedFiles(target: PrTarget, reviewedFiles: string[]): Promise<void> {
    for (const path of reviewedFiles) {
      await gateway.markFileAsViewed(target, path)
    }
  }

  return { submit, syncViewedFiles }
}
