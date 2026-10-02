import { z } from "zod"

// Shared, provider-neutral AI-review boundary. Provider adapters may translate to CLI-specific
// protocol details, but every persisted run and webview-facing event must pass these schemas.

export const aiProviderIdSchema = z.enum(["claude", "codex", "fake"])
export type AiProviderId = z.infer<typeof aiProviderIdSchema>

export const aiReviewTargetSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
})
export type AiReviewTarget = z.infer<typeof aiReviewTargetSchema>

export const reviewProfileSchema = z.enum(["quick", "balanced", "thorough"])
export type ReviewProfile = z.infer<typeof reviewProfileSchema>

export const aiRunStatusSchema = z.enum([
  "running",
  "completed",
  "cancelled",
  "interrupted",
  "failed",
  "invalid",
])
export type AiRunStatus = z.infer<typeof aiRunStatusSchema>

export const aiFindingSeveritySchema = z.enum(["critical", "high", "medium", "low"])
export type AiFindingSeverity = z.infer<typeof aiFindingSeveritySchema>

export const aiFindingConfidenceSchema = z.enum(["high", "medium", "low"])
export type AiFindingConfidence = z.infer<typeof aiFindingConfidenceSchema>

export const aiFindingSourceSchema = z.enum(["code-review", "requirement-mismatch", "chat"])
export type AiFindingSource = z.infer<typeof aiFindingSourceSchema>

export const selectedJiraCriterionSchema = z
  .object({
    issueKey: z.string().min(1),
    criterion: z.string().min(1),
  })
  .strict()
export type SelectedJiraCriterion = z.infer<typeof selectedJiraCriterionSchema>

// The anchor intentionally permits null fields for advisory observations. Later validation checks
// non-null anchors against the base-to-head patch recorded by the immutable run.
export const aiFindingSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: aiFindingSeveritySchema,
    confidence: aiFindingConfidenceSchema,
    category: z.string().min(1),
    path: z.string().min(1).nullable(),
    side: z.enum(["LEFT", "RIGHT"]).nullable(),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    evidence: z.string().min(1),
    impact: z.string().min(1),
    suggestedFix: z.string().min(1).nullable(),
    source: aiFindingSourceSchema,
    // Requirement-mismatch findings must name the selected Jira criterion they claim conflicts
    // with. The terminal validator resolves this reference against immutable coverage.
    requirementCriterion: selectedJiraCriterionSchema.optional(),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.source === "requirement-mismatch" && finding.requirementCriterion === undefined) {
      context.addIssue({
        code: "custom",
        message: "Requirement-mismatch findings require a selected Jira criterion reference",
        path: ["requirementCriterion"],
      })
    }
  })
export type AiFinding = z.infer<typeof aiFindingSchema>

export const requirementStateSchema = z.enum([
  "met",
  "partially-met",
  "not-evidenced",
  "contradicted",
])
export type RequirementState = z.infer<typeof requirementStateSchema>

export const requirementEvidenceSourceSchema = z.enum(["jira", "code", "test", "no-code-evidence"])
export type RequirementEvidenceSource = z.infer<typeof requirementEvidenceSourceSchema>

export const requirementEvidenceSchema = z
  .object({
    source: requirementEvidenceSourceSchema,
    reference: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict()
export type RequirementEvidence = z.infer<typeof requirementEvidenceSchema>

export const requirementCoverageItemSchema = z
  .object({
    issueKey: z.string().min(1),
    criterion: z.string().min(1),
    state: requirementStateSchema,
    evidence: z.array(requirementEvidenceSchema),
    reviewerQuestion: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    const hasJiraCitation = item.evidence.some((evidence) => evidence.source === "jira")
    if (!hasJiraCitation) {
      context.addIssue({
        code: "custom",
        message: "Requirement conclusions require a Jira criterion citation",
        path: ["evidence"],
      })
    }

    if (item.reviewerQuestion !== null) return

    const hasCodeCitation = item.evidence.some(
      (evidence) => evidence.source === "code" || evidence.source === "test"
    )
    const hasNoCodeEvidence = item.evidence.some(
      (evidence) => evidence.source === "no-code-evidence"
    )

    if (item.state === "not-evidenced") {
      if (!hasNoCodeEvidence) {
        context.addIssue({
          code: "custom",
          message: "Not-evidenced requirements require an explicit no-code-evidence citation",
          path: ["evidence"],
        })
      }
      if (hasCodeCitation) {
        context.addIssue({
          code: "custom",
          message: "Not-evidenced requirements cannot claim code or test evidence",
          path: ["evidence"],
        })
      }
      return
    }

    if (!hasCodeCitation) {
      context.addIssue({
        code: "custom",
        message: "Requirement conclusions require code or test evidence",
        path: ["evidence"],
      })
    }
    if (hasNoCodeEvidence) {
      context.addIssue({
        code: "custom",
        message: "Only not-evidenced requirements may use no-code-evidence citations",
        path: ["evidence"],
      })
    }
  })
export type RequirementCoverageItem = z.infer<typeof requirementCoverageItemSchema>

export const requirementCoverageSchema = z
  .object({
    status: z.enum(["available", "partial", "unavailable"]),
    items: z.array(requirementCoverageItemSchema),
    unavailableIssueKeys: z.array(z.string().min(1)),
  })
  .strict()
export type RequirementCoverage = z.infer<typeof requirementCoverageSchema>

export const reviewCoverageSchema = z
  .object({
    reviewedPaths: z.array(z.string().min(1)),
    skipped: z.array(
      z
        .object({
          path: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict()
    ),
    failedChunks: z.array(z.string().min(1)),
    missingContent: z.array(z.string().min(1)),
    excludedSensitivePaths: z.array(z.string().min(1)),
    synthesisCompleted: z.boolean(),
  })
  .strict()
export type ReviewCoverage = z.infer<typeof reviewCoverageSchema>

export const reviewUsageSchema = z
  .object({
    elapsedMs: z.number().int().nonnegative(),
    parentAgentCount: z.number().int().nonnegative(),
    nestedAgentCount: z.number().int().nonnegative(),
    toolEventCount: z.number().int().nonnegative(),
    approvedCommandCount: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    providerCost: z.number().nonnegative().nullable(),
  })
  .strict()
export type ReviewUsage = z.infer<typeof reviewUsageSchema>

// Model output is immutable after the run reaches a terminal status. Reviewer workflow state is
// stored separately in FindingDisposition records so dismissing a finding never rewrites output.
export const observedCodexSafeProfileProvenanceSchema = z
  .object({
    executableIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    cliVersion: z.string().min(1),
    helpDigest: z.string().regex(/^[a-f0-9]{64}$/),
    safeProfileRevision: z.string().min(1),
    // One broker-observed executable/help/profile binding. It contains no local path or output.
    provenanceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ObservedCodexSafeProfileProvenance = z.infer<
  typeof observedCodexSafeProfileProvenanceSchema
>

export const aiReviewRunSchema = z
  .object({
    id: z.string().min(1),
    target: aiReviewTargetSchema,
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    inputFingerprint: z.string().min(1),
    contextSecurityFingerprint: z.string().min(1),
    provider: aiProviderIdSchema,
    selectedModel: z.string().min(1).nullable(),
    reportedModel: z.string().min(1).nullable(),
    cliVersion: z.string().min(1),
    // Codex runs persist only broker-observed launch identity; legacy/fake records have none.
    observedProvenance: observedCodexSafeProfileProvenanceSchema.optional(),
    promptVersion: z.string().min(1),
    profile: reviewProfileSchema,
    status: aiRunStatusSchema,
    summary: z.string().min(1).nullable(),
    findings: z.array(aiFindingSchema),
    requirementCoverage: requirementCoverageSchema.nullable(),
    coverage: reviewCoverageSchema,
    usage: reviewUsageSchema,
    createdAt: z.string().min(1),
    completedAt: z.string().min(1).nullable(),
  })
  .superRefine((run, context) => {
    if (run.provider !== "codex") return
    if (run.observedProvenance === undefined) {
      context.addIssue({
        code: "custom",
        message: "Codex runs require the exact observed provenance receipt identity",
        path: ["observedProvenance"],
      })
      return
    }
    if (run.cliVersion !== run.observedProvenance.cliVersion) {
      context.addIssue({
        code: "custom",
        message: "Codex run CLI version must match its observed provenance receipt",
        path: ["cliVersion"],
      })
    }
  })
export type AiReviewRun = z.infer<typeof aiReviewRunSchema>

export const findingDispositionStateSchema = z.enum([
  "open",
  "dismissed",
  "saved-as-draft",
  "resolved",
])
export type FindingDispositionState = z.infer<typeof findingDispositionStateSchema>

export const findingDismissalReasonSchema = z.enum([
  "false-positive",
  "not-relevant",
  "accepted-risk",
  "other",
])
export type FindingDismissalReason = z.infer<typeof findingDismissalReasonSchema>

export const findingDispositionSchema = z
  .object({
    runId: z.string().min(1),
    findingId: z.string().min(1),
    state: findingDispositionStateSchema,
    dismissalReason: findingDismissalReasonSchema.optional(),
    note: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .superRefine((disposition, context) => {
    if (disposition.state === "dismissed" && !disposition.dismissalReason) {
      context.addIssue({
        code: "custom",
        message: "Dismissed findings require a dismissal reason",
        path: ["dismissalReason"],
      })
    }
    if (disposition.state !== "dismissed" && disposition.dismissalReason) {
      context.addIssue({
        code: "custom",
        message: "Only dismissed findings may carry a dismissal reason",
        path: ["dismissalReason"],
      })
    }
  })
export type FindingDisposition = z.infer<typeof findingDispositionSchema>

export const aiReviewEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), runId: z.string().min(1), message: z.string().min(1) }),
  z.object({
    type: z.literal("permission-request"),
    runId: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({ type: z.literal("diagnostic"), runId: z.string().min(1), message: z.string().min(1) }),
  z.object({ type: z.literal("completed"), runId: z.string().min(1) }),
])
export type AiReviewEvent = z.infer<typeof aiReviewEventSchema>

export const aiReviewErrorSchema = z.object({
  code: z.enum([
    "provider-unavailable",
    "capability-missing",
    "cancelled",
    "timeout",
    "invalid-output",
    "process-failed",
    "permission-denied",
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
})
export type AiReviewError = z.infer<typeof aiReviewErrorSchema>

export const providerConfigurationSchema = z.object({
  provider: aiProviderIdSchema,
  executablePath: z.string().min(1).nullable(),
  selectedModel: z.string().min(1).nullable(),
})
export type ProviderConfiguration = z.infer<typeof providerConfigurationSchema>

export const providerCapabilitiesSchema = z.object({
  available: z.boolean(),
  executablePath: z.string().min(1).nullable(),
  cliVersion: z.string().min(1).nullable(),
  // A provider projection may expose only this opaque observed identity; executable paths and
  // bytes remain Rust-owned. Consent must bind this full fingerprint, not just CLI version.
  observedProvenance: observedCodexSafeProfileProvenanceSchema.optional(),
  missingCapabilities: z.array(z.string().min(1)),
  warning: z.string().min(1).nullable(),
})
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>

export const reviewRunInputSchema = z.object({
  runId: z.string().min(1),
  target: aiReviewTargetSchema,
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  inputFingerprint: z.string().min(1),
  contextSecurityFingerprint: z.string().min(1),
  configuration: providerConfigurationSchema,
  profile: reviewProfileSchema,
})
export type ReviewRunInput = z.infer<typeof reviewRunInputSchema>

// Coverage and usage are app/broker-owned facts. Provider terminal output may contain only the
// model-owned review fields below; the lifecycle supplies coverage and usage before this complete
// persisted-output contract is validated.
export const codexSafeProfileReviewTerminalSchema = z
  .object({
    summary: z.string().min(1),
    findings: z.array(aiFindingSchema),
    requirementCoverage: requirementCoverageSchema.nullable(),
    reportedModel: z.string().min(1).nullable(),
  })
  .strict()
export type CodexSafeProfileReviewTerminal = z.infer<typeof codexSafeProfileReviewTerminalSchema>

export const reviewRunOutputSchema = z
  .object({
    summary: z.string().min(1),
    findings: z.array(aiFindingSchema),
    requirementCoverage: requirementCoverageSchema.nullable(),
    coverage: reviewCoverageSchema,
    usage: reviewUsageSchema,
    reportedModel: z.string().min(1).nullable(),
  })
  .strict()
export type ReviewRunOutput = z.infer<typeof reviewRunOutputSchema>

export const chatScopeSchema = z.enum(["selection", "file", "finding", "whole-pr"])
export type ChatScope = z.infer<typeof chatScopeSchema>

// Persisted chat context is a reference to reviewed material, never a copy of selected source.
// The broker supplies the permitted source only when rebuilding a fresh provider session.
export const chatContextReferenceSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("selection"),
    path: z.string().min(1),
    side: z.enum(["LEFT", "RIGHT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  z.object({ scope: z.literal("file"), path: z.string().min(1) }),
  z.object({
    scope: z.literal("finding"),
    runId: z.string().min(1),
    findingId: z.string().min(1),
  }),
  z.object({ scope: z.literal("whole-pr") }),
])
export type ChatContextReference = z.infer<typeof chatContextReferenceSchema>

const focusedChatContextReferenceSchema = z.union([
  z.object({ scope: z.literal("file"), path: z.string().min(1) }),
  z.object({
    scope: z.literal("finding"),
    runId: z.string().min(1),
    findingId: z.string().min(1),
  }),
])

export const aiChatThreadSchema = z
  .object({
    id: z.string().min(1),
    target: aiReviewTargetSchema,
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    kind: z.enum(["main", "focused"]),
    focusedContext: focusedChatContextReferenceSchema.nullable(),
    contextSecurityFingerprint: z.string().min(1),
    // Codex threads retain the observed receipt identity that bound their disclosure context.
    // Legacy provider-neutral threads remain representable without a broker receipt.
    observedProvenance: observedCodexSafeProfileProvenanceSchema.optional(),
    createdAt: z.string().min(1),
  })
  .superRefine((thread, context) => {
    if (thread.kind === "main" && thread.focusedContext !== null) {
      context.addIssue({
        code: "custom",
        message: "A main PR chat thread cannot have a focused context",
        path: ["focusedContext"],
      })
    }
    if (thread.kind === "focused" && thread.focusedContext === null) {
      context.addIssue({
        code: "custom",
        message: "A focused chat thread requires a file or finding context",
        path: ["focusedContext"],
      })
    }
  })
export type AiChatThread = z.infer<typeof aiChatThreadSchema>

// An assistant turn retains the exact admitted review snapshot used to build its ephemeral
// prompt. Save-as-finding must validate only against this immutable revision-pinned evidence,
// never against a later display/current patch read.
export const revisionPinnedChatPatchSnapshotSchema = z
  .object({
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    // These two fields duplicate the assistant message binding so storage can reject a snapshot
    // assembled for a different scope or security/provenance context.
    attachedContext: chatContextReferenceSchema,
    contextSecurityFingerprint: z.string().min(1),
    // The assistant snapshot is tied to the same exact broker receipt as its prompt context.
    observedProvenance: observedCodexSafeProfileProvenanceSchema.optional(),
    // A finding scope retains the exact finding disclosed to the model; other scopes retain none.
    disclosedFinding: aiFindingSchema.nullable(),
    patches: z.record(z.string().min(1), z.string()),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const patchPaths = Object.keys(snapshot.patches).sort()
    if (
      snapshot.attachedContext.scope === "selection" ||
      snapshot.attachedContext.scope === "file"
    ) {
      if (
        snapshot.disclosedFinding !== null ||
        patchPaths.length !== 1 ||
        patchPaths[0] !== snapshot.attachedContext.path
      ) {
        context.addIssue({
          code: "custom",
          message: "A selection or file snapshot must retain only its selected path patch",
          path: ["patches"],
        })
      }
      return
    }
    if (snapshot.attachedContext.scope === "finding") {
      const finding = snapshot.disclosedFinding
      if (
        finding === null ||
        finding.id !== snapshot.attachedContext.findingId ||
        (finding.path === null && patchPaths.length !== 0) ||
        (finding.path !== null && (patchPaths.length !== 1 || patchPaths[0] !== finding.path))
      ) {
        context.addIssue({
          code: "custom",
          message: "A finding snapshot must retain only its disclosed finding and permitted patch",
          path: ["disclosedFinding"],
        })
      }
      return
    }
    if (snapshot.disclosedFinding !== null) {
      context.addIssue({
        code: "custom",
        message: "A whole-PR snapshot cannot retain a focused finding",
        path: ["disclosedFinding"],
      })
    }
  })
export type RevisionPinnedChatPatchSnapshot = z.infer<typeof revisionPinnedChatPatchSnapshotSchema>

export const aiChatMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    attachedContext: chatContextReferenceSchema,
    // Provider prose is never parsed into a finding. An assistant may instead return this
    // separately schema-validated candidate for an explicit reviewer Save as finding action.
    findingCandidate: aiFindingSchema.nullable(),
    // User messages carry no source snapshot. Assistant candidates can be saved only when this
    // immutable exact-revision snapshot is retained with their turn.
    recordedPatchSnapshot: revisionPinnedChatPatchSnapshotSchema.nullable(),
    contextSecurityFingerprint: z.string().min(1),
    // User and assistant turns persist the observed Codex receipt when they were created by the
    // safe profile; this prevents a chat identity from collapsing to a CLI version string.
    observedProvenance: observedCodexSafeProfileProvenanceSchema.optional(),
    createdAt: z.string().min(1),
  })
  .superRefine((message, context) => {
    if (message.role === "user" && message.findingCandidate !== null) {
      context.addIssue({
        code: "custom",
        message: "Only assistant messages may carry a finding candidate",
        path: ["findingCandidate"],
      })
    }
    if (message.role === "user" && message.recordedPatchSnapshot !== null) {
      context.addIssue({
        code: "custom",
        message: "Only assistant messages may carry a recorded patch snapshot",
        path: ["recordedPatchSnapshot"],
      })
    }
    if (
      message.role === "assistant" &&
      message.findingCandidate !== null &&
      message.recordedPatchSnapshot === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Assistant finding candidates require their exact revision-pinned patch snapshot",
        path: ["recordedPatchSnapshot"],
      })
    }
    if (
      message.role === "assistant" &&
      message.recordedPatchSnapshot !== null &&
      (JSON.stringify(message.recordedPatchSnapshot.attachedContext) !==
        JSON.stringify(message.attachedContext) ||
        message.recordedPatchSnapshot.contextSecurityFingerprint !==
          message.contextSecurityFingerprint ||
        JSON.stringify(message.recordedPatchSnapshot.observedProvenance) !==
          JSON.stringify(message.observedProvenance))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Assistant patch snapshots must match the turn's attached scope and security provenance",
        path: ["recordedPatchSnapshot"],
      })
    }
  })
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>

// A saved chat finding references immutable assistant output rather than rewriting the message.
// It remains advisory and separate from human review drafts, GitHub publication, and run output.
export const aiSavedChatFindingSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  finding: aiFindingSchema,
  savedAt: z.string().min(1),
})
export type AiSavedChatFinding = z.infer<typeof aiSavedChatFindingSchema>

export const chatTurnInputSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  contextSecurityFingerprint: z.string().min(1),
  configuration: providerConfigurationSchema,
  scope: chatScopeSchema,
  message: z.string().min(1),
})
export type ChatTurnInput = z.infer<typeof chatTurnInputSchema>

export const codexSafeProfileChatTerminalSchema = z
  .object({
    message: z.string().min(1),
    // A candidate is optional-to-save, never inferred from prose. It must still pass recorded
    // patch-anchor validation before becoming an app-owned formal chat finding.
    findingCandidate: aiFindingSchema.nullable(),
    reportedModel: z.string().min(1).nullable(),
  })
  .strict()
export type CodexSafeProfileChatTerminal = z.infer<typeof codexSafeProfileChatTerminalSchema>

export const chatTurnOutputSchema = z
  .object({
    message: z.string().min(1),
    findingCandidate: aiFindingSchema.nullable(),
    reportedModel: z.string().min(1).nullable(),
    usage: reviewUsageSchema,
  })
  .strict()
export type ChatTurnOutput = z.infer<typeof chatTurnOutputSchema>

export type ReviewEventSink = (event: AiReviewEvent) => void | Promise<void>

// This is an app-owned contract. Provider modules implement it, while the broker remains the
// only authority that turns provider requests into executable processes.
export interface AiReviewProvider {
  readonly id: AiProviderId
  probe(configuration: ProviderConfiguration): Promise<ProviderCapabilities>
  review(input: ReviewRunInput, events: ReviewEventSink): Promise<ReviewRunOutput>
  chat(input: ChatTurnInput, events: ReviewEventSink): Promise<ChatTurnOutput>
  cancel(runId: string): Promise<void>
}
