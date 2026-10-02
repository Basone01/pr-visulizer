import type {
  AiFinding,
  AiReviewRun,
  AiReviewTarget,
  DraftComment,
  FindingDisposition,
} from "@pr-visulizer/shared"

import {
  type RecordedReviewPatches,
  validateFindingAnchors,
} from "@/utils/aiReview/findingValidation"

export type CurrentReviewIdentity = Pick<
  AiReviewRun,
  "baseSha" | "headSha" | "inputFingerprint"
> & {
  target: AiReviewTarget
}

export type FindingDraftPromotion = {
  draft: DraftComment
  disposition: FindingDisposition
}

export type FindingDraftPromotionResult =
  | { status: "promoted"; promotion: FindingDraftPromotion }
  | { status: "not-inline"; reason: string }

function findingDraftBody(finding: AiFinding): string {
  const suggestedFix = finding.suggestedFix ? `\n\nSuggested fix: ${finding.suggestedFix}` : ""

  return `${finding.title}\n\n${finding.evidence}\n\nImpact: ${finding.impact}${suggestedFix}`
}

function sameReviewIdentity(
  run: Pick<AiReviewRun, "target" | "baseSha" | "headSha" | "inputFingerprint">,
  current: CurrentReviewIdentity
): boolean {
  return (
    run.target.owner === current.target.owner &&
    run.target.repo === current.target.repo &&
    run.target.number === current.target.number &&
    run.baseSha === current.baseSha &&
    run.headSha === current.headSha &&
    run.inputFingerprint === current.inputFingerprint
  )
}

// Promotion rechecks the selected immutable run against the CURRENT review input and its exact
// current patch. This deliberately keeps stale observations advisory: an old finding cannot
// create an inline GitHub draft merely because its stored anchor once validated.
export function promoteFindingToDraft(
  run: Pick<AiReviewRun, "id" | "target" | "baseSha" | "headSha" | "inputFingerprint">,
  finding: AiFinding,
  current: CurrentReviewIdentity,
  patches: RecordedReviewPatches,
  updatedAt: string
): FindingDraftPromotionResult {
  if (!sameReviewIdentity(run, current)) {
    return {
      status: "not-inline",
      reason:
        "This finding belongs to a stale review input and cannot become a draft until it is rerun.",
    }
  }
  if (!validateFindingAnchors([finding], patches).valid) {
    return {
      status: "not-inline",
      reason: "This finding no longer has a valid anchor in the current exact patch.",
    }
  }
  if (finding.path === null || finding.side === null) {
    return {
      status: "not-inline",
      reason: "Only changed-file findings with a validated patch side can become inline drafts.",
    }
  }
  if (finding.startLine === null || finding.endLine === null) {
    return {
      status: "not-inline",
      reason: "Only findings with a complete validated line range can become inline drafts.",
    }
  }
  if (finding.startLine <= 0 || finding.endLine < finding.startLine) {
    return {
      status: "not-inline",
      reason: "Only findings with an ordered positive line range can become inline drafts.",
    }
  }

  const draft: DraftComment = {
    path: finding.path,
    line: finding.endLine,
    ...(finding.startLine === finding.endLine ? {} : { startLine: finding.startLine }),
    side: finding.side,
    body: findingDraftBody(finding),
  }

  return {
    status: "promoted",
    promotion: {
      draft,
      disposition: {
        runId: run.id,
        findingId: finding.id,
        state: "saved-as-draft",
        updatedAt,
      },
    },
  }
}
