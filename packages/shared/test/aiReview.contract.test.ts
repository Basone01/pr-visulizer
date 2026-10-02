import { describe, expect, it } from "vitest"

import {
  type AiReviewProvider,
  type AiReviewRun,
  aiChatMessageSchema,
  aiReviewEventSchema,
  aiReviewRunSchema,
  codexSafeProfileChatTerminalSchema,
  codexSafeProfileReviewTerminalSchema,
  findingDispositionSchema,
  providerCapabilitiesSchema,
  reviewRunInputSchema,
} from "../src/index.js"

const completeRun: AiReviewRun = {
  id: "run-1",
  target: { owner: "acme", repo: "web", number: 42 },
  baseSha: "base0000",
  headSha: "head1111",
  inputFingerprint: "input-fingerprint",
  contextSecurityFingerprint: "context-security-fingerprint",
  provider: "fake",
  selectedModel: null,
  reportedModel: "fake-model",
  cliVersion: "1.0.0",
  promptVersion: "v1",
  profile: "balanced",
  status: "completed",
  summary: "The rate limit flow is covered.",
  findings: [
    {
      id: "finding-1",
      title: "Retry header is missing",
      severity: "medium",
      confidence: "high",
      category: "correctness",
      path: "src/api/routes/login.ts",
      side: "RIGHT",
      startLine: 12,
      endLine: 12,
      evidence: "The error branch returns no Retry-After header.",
      impact: "Clients cannot determine when to retry.",
      suggestedFix: "Set Retry-After from the configured limit.",
      source: "code-review",
    },
  ],
  requirementCoverage: {
    status: "available",
    items: [
      {
        issueKey: "WEB-42",
        criterion: "Expose retry timing to clients.",
        state: "partially-met",
        evidence: [
          {
            source: "jira",
            reference: "WEB-42 acceptance criteria",
            detail: "The criterion requires retry timing.",
          },
          {
            source: "code",
            reference: "src/api/routes/login.ts:12",
            detail: "The error branch has no retry header.",
          },
        ],
        reviewerQuestion: null,
      },
    ],
    unavailableIssueKeys: [],
  },
  coverage: {
    reviewedPaths: ["src/api/routes/login.ts"],
    skipped: [],
    failedChunks: [],
    missingContent: [],
    excludedSensitivePaths: [".env.production"],
    synthesisCompleted: true,
  },
  usage: {
    elapsedMs: 1500,
    parentAgentCount: 1,
    nestedAgentCount: 0,
    toolEventCount: 2,
    approvedCommandCount: 0,
    inputTokens: null,
    outputTokens: null,
    providerCost: null,
  },
  createdAt: "2026-09-13T10:00:00.000Z",
  completedAt: "2026-09-13T10:00:01.500Z",
}

describe("AI review contract", () => {
  it("accepts immutable validated output and a separate reviewer disposition", () => {
    // Arrange
    const runInput = completeRun
    const reviewerDisposition = {
      runId: runInput.id,
      findingId: runInput.findings[0]?.id,
      state: "dismissed",
      dismissalReason: "false-positive",
      updatedAt: "2026-09-13T10:05:00.000Z",
    }

    // Act
    const run = aiReviewRunSchema.parse(runInput)
    const disposition = findingDispositionSchema.parse(reviewerDisposition)

    // Assert
    expect(run.findings[0]?.title).toBe("Retry header is missing")
    expect(disposition).toMatchObject({ runId: run.id, findingId: run.findings[0]?.id })
  })

  it("requires one observed Codex executable help and profile provenance fingerprint", () => {
    // Arrange
    const codexRun = {
      ...completeRun,
      provider: "codex" as const,
      cliVersion: "0.153.4",
      observedProvenance: {
        executableIdentityDigest: "a".repeat(64),
        cliVersion: "0.153.4",
        helpDigest: "b".repeat(64),
        safeProfileRevision: "codex-safe-profile-r2",
        provenanceFingerprint: "c".repeat(64),
      },
    }
    const missingBinding = structuredClone(codexRun)
    delete (missingBinding.observedProvenance as { provenanceFingerprint?: string })
      .provenanceFingerprint
    const mismatchedCliIdentity = structuredClone(codexRun)
    mismatchedCliIdentity.cliVersion = "0.153.5"

    // Act
    const accepted = aiReviewRunSchema.safeParse(codexRun)
    const rejected = aiReviewRunSchema.safeParse(missingBinding)
    const mismatched = aiReviewRunSchema.safeParse(mismatchedCliIdentity)

    // Assert
    expect(accepted.success).toBe(true)
    expect(rejected.success).toBe(false)
    expect(mismatched.success).toBe(false)
  })

  it("rejects a dismissed finding without the required reviewer reason", () => {
    // Arrange
    const missingReason = {
      runId: "run-1",
      findingId: "finding-1",
      state: "dismissed",
      updatedAt: "2026-09-13T10:05:00.000Z",
    }

    // Act
    const result = findingDispositionSchema.safeParse(missingReason)

    // Assert
    expect(result.success).toBe(false)
  })

  it("requires Jira and code citations unless a requirement is explicitly not evidenced", () => {
    // Arrange
    const uncitedConclusion = structuredClone(completeRun)
    uncitedConclusion.requirementCoverage!.items[0]!.evidence = [
      {
        source: "code",
        reference: "src/api/routes/login.ts:12",
        detail: "The error branch has no retry header.",
      },
    ]
    const explicitNotEvidenced = structuredClone(completeRun)
    explicitNotEvidenced.requirementCoverage!.items[0]!.state = "not-evidenced"
    explicitNotEvidenced.requirementCoverage!.items[0]!.evidence = [
      {
        source: "jira",
        reference: "WEB-42 acceptance criteria",
        detail: "The criterion requires retry timing.",
      },
      {
        source: "no-code-evidence",
        reference: "Reviewed source and tests",
        detail: "No reviewed code or test evidence establishes retry timing.",
      },
    ]

    // Act
    const uncitedResult = aiReviewRunSchema.safeParse(uncitedConclusion)
    const notEvidencedResult = aiReviewRunSchema.safeParse(explicitNotEvidenced)

    // Assert
    expect(uncitedResult.success).toBe(false)
    expect(notEvidencedResult.success).toBe(true)
  })

  it("requires requirement-mismatch findings to name a Jira criterion", () => {
    // Arrange
    const missingCriterionReference = structuredClone(completeRun)
    missingCriterionReference.findings = [
      {
        ...completeRun.findings[0]!,
        id: "requirement-mismatch-1",
        source: "requirement-mismatch",
      },
    ]

    // Act
    const result = aiReviewRunSchema.safeParse(missingCriterionReference)

    // Assert
    expect(result.success).toBe(false)
  })

  it("requires an assistant finding candidate to retain an exact revision-pinned patch snapshot", () => {
    // Arrange
    const candidate = { ...completeRun.findings[0]!, source: "chat" as const }
    const assistantMessage = {
      id: "assistant-message",
      threadId: "thread-1",
      role: "assistant" as const,
      content: "A candidate with recorded evidence.",
      attachedContext: { scope: "whole-pr" as const },
      findingCandidate: candidate,
      recordedPatchSnapshot: {
        baseSha: completeRun.baseSha,
        headSha: completeRun.headSha,
        attachedContext: { scope: "whole-pr" as const },
        contextSecurityFingerprint: completeRun.contextSecurityFingerprint,
        disclosedFinding: null,
        patches: { [candidate.path!]: "@@ -0,0 +1,12 @@\n+line" },
      },
      contextSecurityFingerprint: completeRun.contextSecurityFingerprint,
      createdAt: "2026-09-14T12:00:00.000Z",
    }

    // Act
    const exactSnapshot = aiChatMessageSchema.safeParse(assistantMessage)
    const missingSnapshot = aiChatMessageSchema.safeParse({
      ...assistantMessage,
      recordedPatchSnapshot: null,
    })
    const userSnapshot = aiChatMessageSchema.safeParse({
      ...assistantMessage,
      role: "user",
      findingCandidate: null,
    })

    // Assert
    expect(exactSnapshot.success).toBe(true)
    expect(missingSnapshot.success).toBe(false)
    expect(userSnapshot.success).toBe(false)
  })

  it("fixed_full_review_and_chat_schemas_reject_incomplete_unknown_and_mismatched_fixture_fields", () => {
    // Arrange
    const completeReviewTerminal = {
      summary: "Model-owned review fields only.",
      findings: [],
      requirementCoverage: null,
      reportedModel: null,
    }
    const completeChatTerminal = {
      message: "Model-owned chat fields only.",
      findingCandidate: null,
      reportedModel: null,
    }

    // Act
    const review = codexSafeProfileReviewTerminalSchema.safeParse(completeReviewTerminal)
    const chat = codexSafeProfileChatTerminalSchema.safeParse(completeChatTerminal)
    const unknownCoverage = codexSafeProfileReviewTerminalSchema.safeParse({
      ...completeReviewTerminal,
      coverage: completeRun.coverage,
    })
    const unknownUsage = codexSafeProfileChatTerminalSchema.safeParse({
      ...completeChatTerminal,
      usage: completeRun.usage,
    })
    const incompleteFinding = codexSafeProfileChatTerminalSchema.safeParse({
      ...completeChatTerminal,
      findingCandidate: { id: "incomplete" },
    })
    const mismatchedTerminal = codexSafeProfileReviewTerminalSchema.safeParse(completeChatTerminal)

    // Assert
    expect(review.success).toBe(true)
    expect(chat.success).toBe(true)
    expect(unknownCoverage.success).toBe(false)
    expect(unknownUsage.success).toBe(false)
    expect(incompleteFinding.success).toBe(false)
    expect(mismatchedTerminal.success).toBe(false)
  })

  it("keeps provider process interactions behind the app-owned contract", async () => {
    // Arrange
    const receivedEvents: string[] = []
    const provider: AiReviewProvider = {
      id: "fake",
      async probe() {
        return providerCapabilitiesSchema.parse({
          available: true,
          executablePath: null,
          cliVersion: "1.0.0",
          missingCapabilities: [],
          warning: null,
        })
      },
      async review(input, events) {
        await events({ type: "progress", runId: input.runId, message: "Reviewing changed files" })
        return {
          summary: "Complete",
          findings: [],
          requirementCoverage: null,
          coverage: completeRun.coverage,
          usage: completeRun.usage,
          reportedModel: "fake-model",
        }
      },
      async chat() {
        return {
          message: "Complete",
          findingCandidate: null,
          reportedModel: "fake-model",
          usage: completeRun.usage,
        }
      },
      async cancel() {},
    }
    const input = reviewRunInputSchema.parse({
      runId: "run-1",
      target: completeRun.target,
      baseSha: completeRun.baseSha,
      headSha: completeRun.headSha,
      inputFingerprint: completeRun.inputFingerprint,
      contextSecurityFingerprint: completeRun.contextSecurityFingerprint,
      configuration: { provider: "fake", executablePath: null, selectedModel: null },
      profile: "balanced",
    })

    // Act
    const output = await provider.review(input, async (event) => {
      receivedEvents.push(aiReviewEventSchema.parse(event).type)
    })

    // Assert
    expect(receivedEvents).toEqual(["progress"])
    expect(output.summary).toBe("Complete")
  })
})
