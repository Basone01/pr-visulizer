import type { AiFinding, ReviewRunOutput } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import {
  isPartialReviewCoverage,
  validateFindingAnchors,
  validateReviewRunOutput,
} from "./findingValidation"

const RECORDED_PATCHES = {
  "src/route.ts": [
    "@@ -2,3 +2,4 @@",
    " export function route() {",
    "-  return legacyHandler()",
    "+  return guardedHandler()",
    "+}",
    " }",
  ].join("\n"),
}

function createFinding(overrides: Partial<AiFinding> = {}): AiFinding {
  return {
    id: "finding-1",
    title: "Guard is missing",
    severity: "high",
    confidence: "high",
    category: "security",
    path: "src/route.ts",
    side: "RIGHT",
    startLine: 3,
    endLine: 3,
    evidence: "The handler is exposed without an authorization check.",
    impact: "An unauthorized caller could access protected data.",
    suggestedFix: "Require authorization before invoking the handler.",
    source: "code-review",
    ...overrides,
  }
}

function createOutput(overrides: Partial<ReviewRunOutput> = {}): ReviewRunOutput {
  return {
    summary: "One review concern was found.",
    findings: [createFinding()],
    requirementCoverage: null,
    coverage: {
      reviewedPaths: ["src/route.ts"],
      skipped: [],
      failedChunks: [],
      missingContent: [],
      excludedSensitivePaths: [],
      synthesisCompleted: true,
    },
    usage: {
      elapsedMs: 100,
      parentAgentCount: 1,
      nestedAgentCount: 0,
      toolEventCount: 0,
      approvedCommandCount: 0,
      inputTokens: null,
      outputTokens: null,
      providerCost: null,
    },
    reportedModel: "fake-model",
    ...overrides,
  }
}

describe("AI finding validation", () => {
  it("accepts findings anchored to valid recorded LEFT and RIGHT patch lines", () => {
    // Arrange
    const findings = [
      createFinding({ side: "RIGHT", startLine: 3, endLine: 4 }),
      createFinding({ id: "left-finding", side: "LEFT", startLine: 3, endLine: 3 }),
      createFinding({
        id: "advisory-finding",
        path: "src/unchanged.ts",
        side: null,
        startLine: 20,
        endLine: 20,
      }),
    ]

    // Act
    const validation = validateFindingAnchors(findings, RECORDED_PATCHES)

    // Assert
    expect(validation).toEqual({ valid: true, errors: [] })
  })

  it("rejects findings whose anchor side or line range is absent from the recorded patch", () => {
    // Arrange
    const findings = [
      createFinding({ id: "wrong-side", side: "LEFT", startLine: 5, endLine: 5 }),
      createFinding({ id: "missing-path", path: "src/missing.ts" }),
      createFinding({ id: "gap", startLine: 2, endLine: 6 }),
    ]

    // Act
    const validation = validateFindingAnchors(findings, RECORDED_PATCHES)

    // Assert
    expect(validation).toEqual({
      valid: false,
      errors: [
        {
          findingId: "wrong-side",
          reason: "Finding LEFT line 5 is not present in the recorded patch",
        },
        {
          findingId: "missing-path",
          reason: "Finding path has no recorded base-to-head patch",
        },
        {
          findingId: "gap",
          reason: "Finding RIGHT range is not present in the recorded patch",
        },
      ],
    })
  })

  it("marks malformed or invalid-anchored output invalid instead of completed", () => {
    // Arrange
    const malformedOutput = { findings: [] }
    const invalidAnchorOutput = createOutput({
      findings: [createFinding({ startLine: 99, endLine: 99 })],
    })

    // Act
    const malformedValidation = validateReviewRunOutput(malformedOutput, RECORDED_PATCHES)
    const invalidAnchorValidation = validateReviewRunOutput(invalidAnchorOutput, RECORDED_PATCHES)

    // Assert
    expect(malformedValidation.status).toBe("invalid")
    expect(invalidAnchorValidation).toEqual({
      status: "invalid",
      errors: ["finding-1: Finding RIGHT line 99 is not present in the recorded patch"],
    })
  })

  it("requirement_coverage_rejects_unselected_or_uncited_conclusions", () => {
    // Arrange
    const selectedCriteria = [{ issueKey: "WEB-42", criterion: "Unauthorized access returns 403." }]
    const unselectedConclusion = createOutput({
      findings: [],
      requirementCoverage: {
        status: "available",
        unavailableIssueKeys: [],
        items: [
          {
            issueKey: "OPS-9",
            criterion: "Log every access.",
            state: "met",
            evidence: [
              {
                source: "jira",
                reference: "OPS-9 acceptance criterion 1",
                detail: "The criterion requires access logging.",
              },
              {
                source: "code",
                reference: "src/route.ts:3",
                detail: "The route logs access.",
              },
            ],
            reviewerQuestion: null,
          },
        ],
      },
    })
    const uncitedConclusion = createOutput({
      findings: [],
      requirementCoverage: {
        status: "available",
        unavailableIssueKeys: [],
        items: [
          {
            issueKey: "WEB-42",
            criterion: "Unauthorized access returns 403.",
            state: "met",
            evidence: [
              {
                source: "code",
                reference: "src/route.ts:3",
                detail: "The route rejects unauthorized access.",
              },
            ],
            reviewerQuestion: null,
          },
        ],
      },
    })
    const notEvidencedConclusion = createOutput({
      findings: [],
      requirementCoverage: {
        status: "available",
        unavailableIssueKeys: [],
        items: [
          {
            issueKey: "WEB-42",
            criterion: "Unauthorized access returns 403.",
            state: "not-evidenced",
            evidence: [
              {
                source: "jira",
                reference: "WEB-42 acceptance criterion 1",
                detail: "The criterion requires a 403 response.",
              },
              {
                source: "no-code-evidence",
                reference: "Reviewed source and tests",
                detail: "No reviewed code or test evidence establishes the response status.",
              },
            ],
            reviewerQuestion: null,
          },
        ],
      },
    })

    // Act
    const unselectedValidation = validateReviewRunOutput(
      unselectedConclusion,
      RECORDED_PATCHES,
      selectedCriteria
    )
    const uncitedValidation = validateReviewRunOutput(
      uncitedConclusion,
      RECORDED_PATCHES,
      selectedCriteria
    )
    const notEvidencedValidation = validateReviewRunOutput(
      notEvidencedConclusion,
      RECORDED_PATCHES,
      selectedCriteria
    )

    // Assert
    expect(unselectedValidation).toEqual({
      status: "invalid",
      errors: ["OPS-9: requirement conclusion does not reference a selected Jira criterion"],
    })
    expect(uncitedValidation).toMatchObject({ status: "invalid" })
    expect(notEvidencedValidation).toMatchObject({ status: "completed" })
  })

  it("requirement_mismatch_without_selected_nonconflicting_conclusion_is_invalid", () => {
    // Arrange
    const selectedCriteria = [{ issueKey: "WEB-42", criterion: "Unauthorized access returns 403." }]
    const mismatchFinding = createFinding({
      id: "requirement-mismatch",
      source: "requirement-mismatch",
      requirementCriterion: selectedCriteria[0],
    })
    const selectedConclusion = {
      issueKey: "WEB-42",
      criterion: "Unauthorized access returns 403.",
      state: "contradicted" as const,
      evidence: [
        {
          source: "jira" as const,
          reference: "WEB-42 acceptance criterion 1",
          detail: "The criterion requires a 403 response.",
        },
        {
          source: "code" as const,
          reference: "src/route.ts:3",
          detail: "The route returns a successful response instead.",
        },
      ],
      reviewerQuestion: null,
    }
    const nullCoverageOutput = createOutput({
      findings: [mismatchFinding],
      requirementCoverage: null,
    })
    const unselectedCriterionOutput = createOutput({
      findings: [
        createFinding({
          ...mismatchFinding,
          requirementCriterion: { issueKey: "OPS-9", criterion: "Log every access." },
        }),
      ],
      requirementCoverage: {
        status: "available",
        unavailableIssueKeys: [],
        items: [selectedConclusion],
      },
    })
    const conflictingConclusionOutput = createOutput({
      findings: [mismatchFinding],
      requirementCoverage: {
        status: "available",
        unavailableIssueKeys: [],
        items: [
          {
            ...selectedConclusion,
            reviewerQuestion: "Jira comments disagree about the required response status.",
          },
        ],
      },
    })

    // Act
    const nullCoverageValidation = validateReviewRunOutput(
      nullCoverageOutput,
      RECORDED_PATCHES,
      selectedCriteria
    )
    const unselectedCriterionValidation = validateReviewRunOutput(
      unselectedCriterionOutput,
      RECORDED_PATCHES,
      selectedCriteria
    )
    const conflictingConclusionValidation = validateReviewRunOutput(
      conflictingConclusionOutput,
      RECORDED_PATCHES,
      selectedCriteria
    )

    // Assert
    expect(nullCoverageValidation).toEqual({
      status: "invalid",
      errors: ["requirement-mismatch: requirement mismatch requires requirement coverage"],
    })
    expect(unselectedCriterionValidation).toEqual({
      status: "invalid",
      errors: [
        "requirement-mismatch: requirement mismatch does not reference a selected Jira criterion",
      ],
    })
    expect(conflictingConclusionValidation).toEqual({
      status: "invalid",
      errors: [
        "requirement-mismatch: requirement mismatch cannot reference a conflicting requirement",
      ],
    })
  })

  it("labels disclosed incomplete coverage partial while retaining a completed output", () => {
    // Arrange
    const partialOutput = createOutput({
      coverage: {
        reviewedPaths: ["src/route.ts"],
        skipped: [{ path: "src/generated.ts", reason: "sensitive file excluded" }],
        failedChunks: [],
        missingContent: [],
        excludedSensitivePaths: ["src/generated.ts"],
        synthesisCompleted: false,
      },
    })

    // Act
    const validation = validateReviewRunOutput(partialOutput, RECORDED_PATCHES)
    const partial = isPartialReviewCoverage(partialOutput.coverage)

    // Assert
    expect(validation).toMatchObject({ status: "completed", partial: true })
    expect(partial).toBe(true)
  })
})
