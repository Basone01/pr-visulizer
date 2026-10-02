import type { AiFinding } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { type CurrentReviewIdentity, promoteFindingToDraft } from "./promoteFinding"

const TARGET = { owner: "acme", repo: "webapp", number: 42 }
const RUN = {
  id: "run-1",
  target: TARGET,
  baseSha: "base-sha-1234567",
  headSha: "head-sha-1234567",
  inputFingerprint: "input-fingerprint",
}
const CURRENT_REVIEW: CurrentReviewIdentity = {
  target: TARGET,
  baseSha: RUN.baseSha,
  headSha: RUN.headSha,
  inputFingerprint: RUN.inputFingerprint,
}
const PATCHES = {
  "src/auth/redirect.ts": "@@ -10,3 +10,3 @@\n-old target\n+new target\n context\n context\n",
}

const VALID_FINDING: AiFinding = {
  id: "finding-1",
  title: "Validate the redirect target",
  severity: "high",
  confidence: "high",
  category: "security",
  path: "src/auth/redirect.ts",
  side: "RIGHT",
  startLine: 10,
  endLine: 12,
  evidence: "The target comes from untrusted input.",
  impact: "An attacker can redirect a user.",
  suggestedFix: "Allow only local paths.",
  source: "code-review",
}

describe("promoteFindingToDraft", () => {
  it("promotes a validated anchored finding into an editable local draft with AI provenance", () => {
    // Arrange
    const updatedAt = "2026-09-14T12:00:00.000Z"

    // Act
    const result = promoteFindingToDraft(RUN, VALID_FINDING, CURRENT_REVIEW, PATCHES, updatedAt)

    // Assert
    expect(result).toEqual({
      status: "promoted",
      promotion: {
        draft: {
          path: "src/auth/redirect.ts",
          line: 12,
          startLine: 10,
          side: "RIGHT",
          body: "Validate the redirect target\n\nThe target comes from untrusted input.\n\nImpact: An attacker can redirect a user.\n\nSuggested fix: Allow only local paths.",
        },
        disposition: {
          runId: RUN.id,
          findingId: "finding-1",
          state: "saved-as-draft",
          updatedAt,
        },
      },
    })
  })

  it("keeps a single-line finding in the existing single-line draft shape", () => {
    // Arrange
    const singleLineFinding: AiFinding = { ...VALID_FINDING, startLine: 12, endLine: 12 }

    // Act
    const result = promoteFindingToDraft(
      RUN,
      singleLineFinding,
      CURRENT_REVIEW,
      PATCHES,
      "2026-09-14T12:00:00.000Z"
    )

    // Assert
    expect(result).toMatchObject({
      status: "promoted",
      promotion: { draft: { line: 12, side: "RIGHT" } },
    })
    if (result.status === "promoted") expect(result.promotion.draft.startLine).toBeUndefined()
  })

  it("does not produce a draft, publish action, review-progress update, or ranking input for an unanchored finding", () => {
    // Arrange
    const unanchoredFinding: AiFinding = {
      ...VALID_FINDING,
      path: null,
      side: null,
      startLine: null,
      endLine: null,
    }

    // Act
    const result = promoteFindingToDraft(
      RUN,
      unanchoredFinding,
      CURRENT_REVIEW,
      PATCHES,
      "2026-09-14T12:00:00.000Z"
    )

    // Assert
    expect(result).toEqual({
      status: "not-inline",
      reason: "Only changed-file findings with a validated patch side can become inline drafts.",
    })
  })

  it("rejects a matching run whose anchor no longer exists in the current exact patch", () => {
    // Arrange
    const changedPatch = { "src/auth/redirect.ts": "@@ -20,1 +20,1 @@\n-old\n+new\n" }

    // Act
    const result = promoteFindingToDraft(
      RUN,
      VALID_FINDING,
      CURRENT_REVIEW,
      changedPatch,
      "2026-09-14T12:00:00.000Z"
    )

    // Assert
    expect(result).toEqual({
      status: "not-inline",
      reason: "This finding no longer has a valid anchor in the current exact patch.",
    })
  })
})
