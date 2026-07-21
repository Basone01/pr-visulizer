import type { GithubGateway, PrTarget, ReviewEvent, SubmitReviewResult } from "@pr-visulizer/engine"
import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"

// Review-submit flow (docs/architecture.md §11): map the app-side verdict to a GitHub
// review event and post ONE real review. Goes through the gateway — the only thing that
// talks to GitHub. (The "Viewed" checkboxes are their own two-way concern; they live in the
// engine's viewedSync service, which both this BFF and the desktop client drive.)

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

  return { submit }
}
