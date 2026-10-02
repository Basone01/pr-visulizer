import { describe, expect, it, vi } from "vitest"

import { type KeyValueStore, createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import type { AppAiReviewProvider } from "@/service/aiReview/providers/provider"

import { createCodexReviewContext } from "./codexReviewContext"
import { type CodexSafeProfileBridge, createCodexSafeProfileBridge } from "./codexSafeProfileBridge"
import { createFakeAiReviewProvider } from "./providers/fakeProvider"
import { createAiReviewRunStorage } from "./runStorage"
import { createAiReviewSettingsStorage } from "./settingsStorage"
import {
  createTauriAiReviewClient,
  recoverAndAcknowledgeCodexRuns,
  recoverInterruptedTauriAiReviewRuns,
} from "./tauriAiReviewClient"

const verifiedProvenance = {
  executableIdentityDigest: "a".repeat(64),
  cliVersion: "0.153.4",
  helpDigest: "b".repeat(64),
  safeProfileRevision: "codex-safe-profile-r2",
  provenanceFingerprint: "d".repeat(64),
}

function createReviewInput(runId = "run-1") {
  return {
    runId,
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    inputFingerprint: "input-fingerprint",
    contextSecurityFingerprint: "context-security-fingerprint",
    profile: "balanced" as const,
    promptVersion: "ai-review-v1",
    recordedPatches: {
      baseSha: "base-sha",
      headSha: "head-sha",
      patches: {},
    },
  }
}

async function createCodexContext(
  selectedModel: string | null = null,
  observedProvenance = verifiedProvenance
) {
  return createCodexReviewContext({
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    recordedPatches: {
      baseSha: "base-sha",
      headSha: "head-sha",
      patches: { "src/route.ts": "@@ -1,1 +1,1 @@\n-old handler\n+new handler\n" },
    },
    title: "Protect the route",
    description: null,
    githubComments: [],
    selectedJiraSnapshots: [],
    effectiveInstructions: [],
    contextPolicy: {
      includedPaths: ["src/route.ts"],
      excludedPaths: [],
      mode: "hard-exclusion",
    },
    priorFeedback: { enabled: false, content: null },
    profile: "balanced",
    selectedModel,
    observedProvenance,
  })
}

function createRunningCodexRun(runId: string) {
  const reviewInput = createReviewInput(runId)
  return {
    id: reviewInput.runId,
    target: reviewInput.target,
    baseSha: reviewInput.baseSha,
    headSha: reviewInput.headSha,
    inputFingerprint: reviewInput.inputFingerprint,
    contextSecurityFingerprint: reviewInput.contextSecurityFingerprint,
    provider: "codex" as const,
    selectedModel: null,
    cliVersion: "0.153.4",
    observedProvenance: verifiedProvenance,
    promptVersion: "ai-review-v1",
    profile: "balanced" as const,
    status: "running" as const,
    createdAt: "2026-09-13T12:00:00.000Z",
    completedAt: null,
    summary: null,
    findings: [],
    requirementCoverage: null,
    coverage: {
      reviewedPaths: [],
      skipped: [],
      failedChunks: [],
      missingContent: [],
      excludedSensitivePaths: [],
      synthesisCompleted: false,
    },
    usage: {
      elapsedMs: 0,
      parentAgentCount: 0,
      nestedAgentCount: 0,
      toolEventCount: 0,
      approvedCommandCount: 0,
      inputTokens: null,
      outputTokens: null,
      providerCost: null,
    },
    reportedModel: null,
  }
}

function createCodexOutput(overrides = {}) {
  return {
    summary: "Codex completed the bounded review.",
    findings: [],
    requirementCoverage: null,
    reportedModel: null,
    ...overrides,
  }
}

describe("Tauri AI review client", () => {
  it("completes the fake-provider review lifecycle with immutable output and sanitized events", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const client = createTauriAiReviewClient({
      storage,
      now: () => "2026-09-13T12:00:00.000Z",
    })
    const reviewInput = createReviewInput()

    // Act
    const lifecycle = client.startFakeReview(reviewInput)
    const completedRun = await lifecycle.completion

    // Assert
    expect(completedRun).toMatchObject({
      id: reviewInput.runId,
      provider: "fake",
      status: "completed",
      summary: "Fake provider completed the review.",
      completedAt: "2026-09-13T12:00:00.000Z",
    })
    expect(await client.storage.loadRun(reviewInput.runId)).toEqual(completedRun)
    expect(await client.storage.loadDiagnostics(reviewInput.runId)).toEqual({
      runId: reviewInput.runId,
      sanitizedEvents: [
        {
          type: "progress",
          runId: reviewInput.runId,
          message: "Preparing deterministic fake review",
        },
        {
          type: "diagnostic",
          runId: reviewInput.runId,
          message: "Fake provider produced schema-valid fixture output",
        },
        { type: "completed", runId: reviewInput.runId },
      ],
      rawModelOutputPermitted: false,
      rawModelOutput: null,
    })
  })

  it("marks a user-cancelled fake review as cancelled without persisting model output", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const client = createTauriAiReviewClient({ storage })
    const reviewInput = createReviewInput("cancelled-run")

    // Act
    const lifecycle = client.startFakeReview(reviewInput)
    await lifecycle.cancel()
    const cancelledRun = await lifecycle.completion

    // Assert
    expect(cancelledRun).toMatchObject({
      id: reviewInput.runId,
      status: "cancelled",
      summary: null,
      findings: [],
      completedAt: expect.any(String),
    })
    expect(await client.storage.loadDiagnostics(reviewInput.runId)).toEqual({
      runId: reviewInput.runId,
      sanitizedEvents: [],
      rawModelOutputPermitted: false,
      rawModelOutput: null,
    })
  })

  it("startup_recovery_marks_abandoned_local_run_interrupted_before_client_initialization", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const firstClient = createTauriAiReviewClient({ storage })
    const abandonedRun = {
      id: "abandoned-startup-run",
      target: { owner: "acme", repo: "web", number: 42 },
      baseSha: "base-sha",
      headSha: "head-sha",
      inputFingerprint: "input-fingerprint",
      contextSecurityFingerprint: "context-security-fingerprint",
      provider: "fake" as const,
      selectedModel: null,
      cliVersion: "1.0.0",
      promptVersion: "ai-review-v1",
      profile: "balanced" as const,
      status: "running" as const,
      createdAt: "2026-09-13T12:00:00.000Z",
      completedAt: null,
      summary: null,
      findings: [],
      requirementCoverage: null,
      coverage: {
        reviewedPaths: [],
        skipped: [],
        failedChunks: [],
        missingContent: [],
        excludedSensitivePaths: [],
        synthesisCompleted: false,
      },
      usage: {
        elapsedMs: 0,
        parentAgentCount: 0,
        nestedAgentCount: 0,
        toolEventCount: 0,
        approvedCommandCount: 0,
        inputTokens: null,
        outputTokens: null,
        providerCost: null,
      },
      reportedModel: null,
    }
    await firstClient.storage.createRun(abandonedRun)

    // Act
    const recovered = await recoverInterruptedTauriAiReviewRuns(storage, "2026-09-13T12:05:00.000Z")
    const restartedClient = createTauriAiReviewClient({ storage })

    // Assert
    expect(recovered).toEqual([
      expect.objectContaining({
        id: abandonedRun.id,
        status: "interrupted",
        completedAt: "2026-09-13T12:05:00.000Z",
      }),
    ])
    expect(await restartedClient.storage.loadRun(abandonedRun.id)).toMatchObject({
      status: "interrupted",
    })
  })

  it("startup_recovery_interrupts_only_rust_safely_resolved_codex_runs", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const client = createTauriAiReviewClient({ storage })
    const runningCodexRun = createRunningCodexRun("safe-codex-recovery")
    const unresolvedCodexRun = { ...runningCodexRun, id: "reused-or-unknown-codex-recovery" }
    await client.storage.createRun(runningCodexRun)
    await client.storage.createRun(unresolvedCodexRun)

    // Act
    const recovered = await recoverInterruptedTauriAiReviewRuns(
      storage,
      "2026-09-13T12:05:00.000Z",
      [runningCodexRun.id]
    )

    // Assert
    expect(recovered).toEqual([
      expect.objectContaining({ id: runningCodexRun.id, status: "interrupted" }),
    ])
    expect(await client.storage.loadRun(runningCodexRun.id)).toMatchObject({
      status: "interrupted",
    })
    expect(await client.storage.loadRun(unresolvedCodexRun.id)).toMatchObject({
      status: "running",
    })
  })

  it("bootstrap_acknowledges_only_durably_interrupted_recovered_runs_before_rust_deletes_evidence", async () => {
    // Arrange
    const backingStore = createMemoryKeyValueStore()
    const interruptedNowRun = createRunningCodexRun("interrupted-now-codex-run")
    const missingLocalRunId = "missing-local-codex-run"
    const alreadyInterruptedRun = createRunningCodexRun("already-interrupted-codex-run")
    const unwritableRun = createRunningCodexRun("unwritable-codex-run")
    const seedStorage = createAiReviewRunStorage(backingStore)
    await seedStorage.createRun(interruptedNowRun)
    await seedStorage.createRun(alreadyInterruptedRun)
    await seedStorage.createRun(unwritableRun)
    await seedStorage.terminateRun(
      alreadyInterruptedRun.id,
      "interrupted",
      "2026-09-13T11:00:00.000Z"
    )
    const unwritableRunKey = `ai-review:run:${unwritableRun.id}`
    const storage: KeyValueStore = {
      get: (key) => backingStore.get(key),
      set: async (key, value) => {
        if (key === unwritableRunKey) throw new Error("Local run storage is unavailable")
        await backingStore.set(key, value)
      },
      delete: (key) => backingStore.delete(key),
    }
    const reportedRunIds = [
      interruptedNowRun.id,
      missingLocalRunId,
      alreadyInterruptedRun.id,
      unwritableRun.id,
    ]
    const acknowledgedRunIdBatches: unknown[] = []
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      if (command === "codex_safe_profile_safely_recovered_run_ids") return reportedRunIds
      if (command === "codex_safe_profile_acknowledge_recovered_runs") {
        acknowledgedRunIdBatches.push(args?.runIds)
        return null
      }
      throw new Error(`Unexpected Codex recovery command ${command}`)
    }
    const completedAt = "2026-09-13T12:05:00.000Z"

    // Act
    const interrupted = await recoverAndAcknowledgeCodexRuns(storage, { invoke, completedAt })

    // Assert
    // A reported ID with no local record at all is acknowledged: nothing was ever written for it,
    // so no local interruption can exist and its receipt would otherwise be re-reported forever.
    expect(acknowledgedRunIdBatches).toEqual([
      [interruptedNowRun.id, missingLocalRunId, alreadyInterruptedRun.id],
    ])
    expect(interrupted).toEqual([
      expect.objectContaining({ id: interruptedNowRun.id, status: "interrupted", completedAt }),
    ])
    expect(await seedStorage.loadRun(interruptedNowRun.id)).toMatchObject({
      status: "interrupted",
    })
    expect(await seedStorage.loadRun(unwritableRun.id)).toMatchObject({ status: "running" })
    expect(await seedStorage.loadRun(missingLocalRunId)).toBeNull()
  })

  it("unreadable_local_run_record_keeps_its_recovery_evidence_unacknowledged", async () => {
    // Arrange — two reported IDs whose local record cannot be READ: one whose stored bytes are not
    // a schema-valid run, one whose storage read throws. Neither is proof that no record exists.
    const backingStore = createMemoryKeyValueStore()
    const malformedRecordRunId = "malformed-record-codex-run"
    const unreadableStorageRunId = "unreadable-storage-codex-run"
    const missingRecordRunId = "missing-record-codex-run"
    await backingStore.set(`ai-review:run:${malformedRecordRunId}`, '{"id":"not-a-run"}')
    const storage: KeyValueStore = {
      get: async (key) => {
        if (key === `ai-review:run:${unreadableStorageRunId}`) {
          throw new Error("Local run storage is unavailable")
        }
        return backingStore.get(key)
      },
      set: (key, value) => backingStore.set(key, value),
      delete: (key) => backingStore.delete(key),
    }
    const acknowledgedRunIdBatches: unknown[] = []
    const reportedRunIds = [malformedRecordRunId, unreadableStorageRunId, missingRecordRunId]
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      if (command === "codex_safe_profile_safely_recovered_run_ids") return reportedRunIds
      if (command === "codex_safe_profile_acknowledge_recovered_runs") {
        acknowledgedRunIdBatches.push(args?.runIds)
        return null
      }
      throw new Error(`Unexpected Codex recovery command ${command}`)
    }

    // Act
    const interrupted = await recoverAndAcknowledgeCodexRuns(storage, {
      invoke,
      completedAt: "2026-09-13T12:05:00.000Z",
    })

    // Assert — only the genuinely absent record is acknowledged; both unreadable ones keep their
    // Rust evidence, and neither is reported as interrupted.
    expect(acknowledgedRunIdBatches).toEqual([[missingRecordRunId]])
    expect(interrupted).toEqual([])
  })

  it("diagnostic_write_failure_preserves_completed_terminal_run", async () => {
    // Arrange
    const backingStore = createMemoryKeyValueStore()
    const storage: KeyValueStore = {
      get: (key) => backingStore.get(key),
      set: async (key, value) => {
        if (key.endsWith(":diagnostics")) {
          throw new Error("Permitted diagnostic storage is unavailable")
        }
        await backingStore.set(key, value)
      },
      delete: (key) => backingStore.delete(key),
    }
    const client = createTauriAiReviewClient({ storage })
    const reviewInput = createReviewInput("diagnostic-failure-run")

    // Act
    const terminalRun = await client.startFakeReview(reviewInput).completion

    // Assert
    expect(terminalRun).toMatchObject({
      id: reviewInput.runId,
      status: "completed",
      summary: "Fake provider completed the review.",
    })
    expect(await client.storage.loadRun(reviewInput.runId)).toEqual(terminalRun)
    expect(await client.storage.loadDiagnostics(reviewInput.runId)).toBeNull()
  })

  it("lifecycle_invalid_anchor_finalizes_invalid_not_completed", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const fakeProvider: AppAiReviewProvider = {
      ...createFakeAiReviewProvider(),
      async review(input, events) {
        await events({ type: "progress", runId: input.runId, message: "Returning invalid anchor" })
        return {
          summary: "This result must not complete.",
          findings: [
            {
              id: "invalid-anchor",
              title: "Invalid anchor",
              severity: "high",
              confidence: "high",
              category: "correctness",
              path: "src/not-in-patch.ts",
              side: "RIGHT",
              startLine: 1,
              endLine: 1,
              evidence: "The fixture intentionally lacks this patch.",
              impact: "The invalid output must be rejected.",
              suggestedFix: null,
              source: "code-review",
            },
          ],
          requirementCoverage: null,
          coverage: {
            reviewedPaths: [],
            skipped: [],
            failedChunks: [],
            missingContent: [],
            excludedSensitivePaths: [],
            synthesisCompleted: true,
          },
          usage: {
            elapsedMs: 0,
            parentAgentCount: 1,
            nestedAgentCount: 0,
            toolEventCount: 0,
            approvedCommandCount: 0,
            inputTokens: null,
            outputTokens: null,
            providerCost: null,
          },
          reportedModel: "fake-model",
        }
      },
    }
    const client = createTauriAiReviewClient({ storage, fakeProvider })
    const reviewInput = createReviewInput("invalid-anchor-run")

    // Act
    const terminalRun = await client.startFakeReview(reviewInput).completion

    // Assert
    expect(terminalRun).toMatchObject({
      id: reviewInput.runId,
      status: "invalid",
      findings: [],
      summary: null,
    })
    expect(await client.storage.loadRun(reviewInput.runId)).toEqual(terminalRun)
  })

  it("fixed_schema_terminal_fixture_reaches_shared_validation_without_model_coverage_or_usage", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const context = await createCodexContext("selected-successful-model")
    const validBridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: verifiedProvenance,
        receiptId: "test-receipt",
        diagnostics: [],
      })),
      run: vi.fn((_request, terminalSchema, onEvent, onAdmission) => {
        const admitted = { runId: "codex-valid-run", provenance: verifiedProvenance }
        const admission = Promise.resolve(onAdmission?.(admitted)).then(() => admitted)
        const completion = admission.then(async () => {
          await onEvent?.({ type: "started", runId: "codex-valid-run" })
          await onEvent?.({ type: "progress", runId: "codex-valid-run" })
          await onEvent?.({
            type: "completed",
            runId: "codex-valid-run",
            result: createCodexOutput({ reportedModel: "reported-successful-model" }),
            usage: { elapsedMs: 42, toolEventCount: 0 },
          })
          return terminalSchema.parse(
            createCodexOutput({ reportedModel: "reported-successful-model" })
          )
        })
        return { admission, completion }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const invalidBridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: verifiedProvenance,
        receiptId: "test-receipt",
        diagnostics: [],
      })),
      run: vi.fn((_request, terminalSchema, _onEvent, onAdmission) => {
        const admitted = { runId: "codex-invalid-run", provenance: verifiedProvenance }
        const admission = Promise.resolve(onAdmission?.(admitted)).then(() => admitted)
        const completion = admission.then(() =>
          terminalSchema.parse(
            createCodexOutput({
              reportedModel: "failed-model-must-not-be-remembered",
              findings: [
                {
                  id: "wrong-anchor",
                  title: "Wrong revision anchor",
                  severity: "high",
                  confidence: "high",
                  category: "correctness",
                  path: "src/not-in-patch.ts",
                  side: "RIGHT",
                  startLine: 1,
                  endLine: 1,
                  evidence: "This path is absent from the recorded patch.",
                  impact: "The output must not complete.",
                  suggestedFix: null,
                  source: "code-review",
                },
              ],
            })
          )
        )
        return { admission, completion }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const streamedEvents: string[] = []
    const validClient = createTauriAiReviewClient({
      storage,
      codexBridge: validBridge,
      now: () => "2026-09-13T12:00:00.000Z",
    })
    const invalidClient = createTauriAiReviewClient({
      storage,
      codexBridge: invalidBridge,
      now: () => "2026-09-13T12:00:01.000Z",
    })

    // Act
    const completedRun = await validClient.startCodexSafeProfileReview({
      runId: "codex-valid-run",
      context,
      onEvent: (event) => streamedEvents.push("message" in event ? event.message : event.type),
    }).completion
    const invalidRun = await invalidClient.startCodexSafeProfileReview({
      runId: "codex-invalid-run",
      context,
    }).completion

    // Assert
    expect(completedRun).toMatchObject({
      id: "codex-valid-run",
      provider: "codex",
      status: "completed",
      summary: "Codex completed the bounded review.",
      coverage: {
        reviewedPaths: ["src/route.ts"],
        skipped: [],
        failedChunks: [],
        missingContent: [],
        excludedSensitivePaths: [],
        synthesisCompleted: true,
      },
      usage: {
        elapsedMs: 42,
        parentAgentCount: 0,
        nestedAgentCount: 0,
        toolEventCount: 0,
        approvedCommandCount: 0,
        inputTokens: null,
        outputTokens: null,
        providerCost: null,
      },
    })
    expect(invalidRun).toMatchObject({
      id: "codex-invalid-run",
      provider: "codex",
      status: "invalid",
      summary: null,
      findings: [],
    })
    expect(
      (await createAiReviewSettingsStorage(storage).load()).providers.codex.successfulModelIds
    ).toEqual(["selected-successful-model", "reported-successful-model"])
    expect(streamedEvents).toEqual([
      "Codex safe-profile started",
      "Codex safe-profile is processing bounded review context",
      "completed",
    ])
    expect(await validClient.storage.loadDiagnostics("codex-valid-run")).toEqual({
      runId: "codex-valid-run",
      sanitizedEvents: [
        {
          type: "progress",
          runId: "codex-valid-run",
          message: "Codex safe-profile started",
        },
        {
          type: "progress",
          runId: "codex-valid-run",
          message: "Codex safe-profile is processing bounded review context",
        },
        { type: "completed", runId: "codex-valid-run" },
      ],
      rawModelOutputPermitted: false,
      rawModelOutput: null,
    })
    expect(validBridge.run).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-valid-run",
        prKey: "acme/web#42",
        operation: "review",
        prompt: context.prompt,
        model: "selected-successful-model",
        provenanceReceiptId: "test-receipt",
        isCancelled: expect.any(Function),
      }),
      expect.anything(),
      expect.any(Function),
      expect.any(Function)
    )
  })

  it("scoped_codex_safe_profile_chat_is_ephemeral_and_uses_typed_chat_output", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const bridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: verifiedProvenance,
        receiptId: "test-receipt",
        diagnostics: [],
      })),
      run: vi.fn((request, terminalSchema, onEvent, onAdmission) => {
        const admitted = { runId: request.runId, provenance: verifiedProvenance }
        const admission = Promise.resolve(onAdmission?.(admitted)).then(() => admitted)
        const completion = admission.then(async () => {
          await onEvent?.({
            type: "completed",
            runId: request.runId,
            result: {},
            usage: { elapsedMs: 24, toolEventCount: 0 },
          })
          return terminalSchema.parse({
            message: "The selected route still needs an authorization test.",
            findingCandidate: {
              id: "chat-candidate",
              title: "Add authorization coverage",
              severity: "medium",
              confidence: "high",
              category: "tests",
              path: "src/route.ts",
              side: "RIGHT",
              startLine: 1,
              endLine: 1,
              evidence: "The bounded patch changes the route branch.",
              impact: "Authorization behavior could regress.",
              suggestedFix: "Add a branch test.",
              source: "chat",
            },
            reportedModel: null,
          })
        })
        return { admission, completion }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const client = createTauriAiReviewClient({ storage, codexBridge: bridge })
    const thread = {
      id: "chat-thread",
      target: { owner: "acme", repo: "web", number: 42 },
      baseSha: "base-sha",
      headSha: "head-sha",
      kind: "main" as const,
      focusedContext: null,
      contextSecurityFingerprint: "context-security-fingerprint",
      createdAt: "2026-09-13T12:00:00.000Z",
    }

    // Act
    const output = await client.startCodexSafeProfileChat({
      runId: "codex-chat-run",
      thread,
      attachedContext: { scope: "file", path: "src/route.ts" },
      message: "Is authorization tested?",
      prompt: "App-owned scope-bound chat prompt",
      model: null,
      observedProvenance: verifiedProvenance,
      history: [],
    }).completion

    // Assert
    expect(output.findingCandidate).toMatchObject({ id: "chat-candidate", source: "chat" })
    expect(bridge.run).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-chat-run",
        prKey: "acme/web#42",
        operation: "chat",
        prompt: "App-owned scope-bound chat prompt",
        model: null,
        provenanceReceiptId: "test-receipt",
        isCancelled: expect.any(Function),
      }),
      expect.anything(),
      expect.any(Function),
      expect.any(Function)
    )
    expect(await client.storage.listRuns()).toEqual([])
  })

  it("review_and_chat_generation_bound_consent_latched_cancellation_never_start_stale_admission", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    let resolveCapability!: (
      value: Awaited<ReturnType<CodexSafeProfileBridge["capability"]>>
    ) => void
    const capability = new Promise<Awaited<ReturnType<CodexSafeProfileBridge["capability"]>>>(
      (resolve) => {
        resolveCapability = resolve
      }
    )
    const bridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => capability),
      run: vi.fn(() => ({
        admission: new Promise<never>(() => {}),
        completion: new Promise<never>(() => {}),
      })),
      cancel: vi.fn(async () => undefined),
    }
    const client = createTauriAiReviewClient({ storage, codexBridge: bridge })
    const context = await createCodexContext()
    const thread = {
      id: "generation-chat-thread",
      target: context.target,
      baseSha: context.baseSha,
      headSha: context.headSha,
      kind: "main" as const,
      focusedContext: null,
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createdAt: "2026-09-13T12:00:00.000Z",
    }
    const review = client.startCodexSafeProfileReview({ runId: "generation-review", context })
    const chat = client.startCodexSafeProfileChat({
      runId: "generation-chat",
      thread,
      attachedContext: { scope: "whole-pr" },
      message: "Does this stay bounded?",
      prompt: "App-owned bounded chat prompt",
      model: null,
      observedProvenance: verifiedProvenance,
      history: [],
    })

    // Act
    await Promise.all([review.cancel(), chat.cancel()])
    resolveCapability({
      available: true,
      cliVersion: "0.153.4",
      coreControlsVerified: true,
      provenance: verifiedProvenance,
      receiptId: "test-receipt",
      diagnostics: [],
    })

    // Assert
    await expect(review.completion).rejects.toThrow("cancelled before broker admission")
    await expect(chat.admission!).rejects.toThrow("cancelled before broker admission")
    await expect(chat.completion).rejects.toThrow("cancelled before broker admission")
    expect(bridge.run).not.toHaveBeenCalled()
    expect(await client.storage.listRuns()).toEqual([])
    expect(bridge.cancel).toHaveBeenCalledTimes(2)
  })

  it("settles_chat_admission_for_unavailable_receipt_mismatch_and_cancelled_pre_admission", async () => {
    // Arrange
    const context = await createCodexContext()
    const thread = {
      id: "pre-admission-settlement-thread",
      target: context.target,
      baseSha: context.baseSha,
      headSha: context.headSha,
      kind: "main" as const,
      focusedContext: null,
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createdAt: "2026-09-13T12:00:00.000Z",
    }
    const startChat = (bridge: CodexSafeProfileBridge, runId: string) =>
      createTauriAiReviewClient({
        storage: createMemoryKeyValueStore(),
        codexBridge: bridge,
      }).startCodexSafeProfileChat({
        runId,
        thread,
        attachedContext: { scope: "whole-pr" },
        message: "Does this pre-admission failure settle?",
        prompt: "Bounded chat prompt",
        model: null,
        observedProvenance: verifiedProvenance,
        history: [],
      })
    const unavailableBridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: false,
        cliVersion: null,
        coreControlsVerified: false,
        diagnostics: ["receipt unavailable"],
      })),
      run: vi.fn(),
      cancel: vi.fn(async () => undefined),
    }
    const mismatchBridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: { ...verifiedProvenance, provenanceFingerprint: "e".repeat(64) },
        receiptId: "mismatched-receipt",
        diagnostics: [],
      })),
      run: vi.fn(),
      cancel: vi.fn(async () => undefined),
    }
    let resolveCapability!: (
      value: Awaited<ReturnType<CodexSafeProfileBridge["capability"]>>
    ) => void
    const pendingCapability = new Promise<
      Awaited<ReturnType<CodexSafeProfileBridge["capability"]>>
    >((resolve) => {
      resolveCapability = resolve
    })
    const cancellationBridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => pendingCapability),
      run: vi.fn(),
      cancel: vi.fn(async () => undefined),
    }

    // Act
    const unavailable = startChat(unavailableBridge, "unavailable-chat")
    const mismatch = startChat(mismatchBridge, "mismatched-chat")
    const cancelled = startChat(cancellationBridge, "cancelled-chat")
    await cancelled.cancel()
    resolveCapability({
      available: true,
      cliVersion: "0.153.4",
      coreControlsVerified: true,
      provenance: verifiedProvenance,
      receiptId: "test-receipt",
      diagnostics: [],
    })

    // Assert
    await expect(unavailable.admission!).rejects.toThrow("provenance receipt is unavailable")
    await expect(unavailable.completion).rejects.toThrow("provenance receipt is unavailable")
    await expect(mismatch.admission!).rejects.toThrow("capability provenance does not match")
    await expect(mismatch.completion).rejects.toThrow("capability provenance does not match")
    await expect(cancelled.admission!).rejects.toThrow("cancelled before broker admission")
    await expect(cancelled.completion).rejects.toThrow("cancelled before broker admission")
    expect(unavailableBridge.run).not.toHaveBeenCalled()
    expect(mismatchBridge.run).not.toHaveBeenCalled()
    expect(cancellationBridge.run).not.toHaveBeenCalled()
  })

  it("bridge_settles_pre_admission_failure_and_serializes_admitted_failure_after_storage_ack", async () => {
    // Arrange
    const backingStore = createMemoryKeyValueStore()
    let releaseAdmissionStorage!: () => void
    const admissionStorage = new Promise<void>((resolve) => {
      releaseAdmissionStorage = resolve
    })
    let admissionStorageStarted = false
    const storage: KeyValueStore = {
      get: (key) => backingStore.get(key),
      set: async (key, value) => {
        if (key.endsWith(":run:admitted-failure")) {
          admissionStorageStarted = true
          await admissionStorage
        }
        await backingStore.set(key, value)
      },
      delete: (key) => backingStore.delete(key),
    }
    const eventHandlers: ((event: { payload: unknown }) => void)[] = []
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        listen: async (_event, handler) => {
          eventHandlers.push(handler)
          return () => undefined
        },
        invoke: async (command, args) => {
          if (command === "codex_safe_profile_capability") {
            return {
              available: true,
              cliVersion: "0.153.4",
              coreControlsVerified: true,
              provenance: verifiedProvenance,
              receiptId: "test-receipt",
              diagnostics: [],
            }
          }
          if (command === "codex_safe_profile_start") {
            const runId = (args?.request as { runId: string }).runId
            if (runId === "admitted-failure") {
              eventHandlers.forEach((handler) =>
                handler({ payload: { type: "admitted", runId, provenance: verifiedProvenance } })
              )
            }
            eventHandlers.forEach((handler) =>
              handler({
                payload: {
                  type: "failed",
                  runId,
                  code: "broker-failed",
                  provenance: verifiedProvenance,
                },
              })
            )
            return { runId }
          }
          if (command === "codex_safe_profile_cancel") return undefined
          throw new Error(`Unexpected command: ${command}`)
        },
      })
    )
    const client = createTauriAiReviewClient({ storage, codexBridge: bridge })
    const context = await createCodexContext()
    const thread = {
      id: "pre-admission-chat-thread",
      target: context.target,
      baseSha: context.baseSha,
      headSha: context.headSha,
      kind: "main" as const,
      focusedContext: null,
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createdAt: "2026-09-13T12:00:00.000Z",
    }

    // Act
    const preAdmissionReview = client.startCodexSafeProfileReview({
      runId: "pre-admission-review",
      context,
    })
    const preAdmissionChat = client.startCodexSafeProfileChat({
      runId: "pre-admission-chat",
      thread,
      attachedContext: { scope: "whole-pr" },
      message: "Does this terminal persist anything?",
      prompt: "Bounded chat prompt",
      model: null,
      observedProvenance: verifiedProvenance,
      history: [],
    })
    const admittedFailure = client.startCodexSafeProfileReview({
      runId: "admitted-failure",
      context,
    })
    const preAdmissionReviewRejected = expect(preAdmissionReview.completion).rejects.toThrow(
      "broker-failed"
    )
    const preAdmissionChatAdmissionRejected = expect(preAdmissionChat.admission!).rejects.toThrow(
      "broker-failed"
    )
    const preAdmissionChatCompletionRejected = expect(preAdmissionChat.completion).rejects.toThrow(
      "broker-failed"
    )
    await vi.waitFor(() => expect(admissionStorageStarted).toBe(true))
    let admittedCompletionSettled = false
    void admittedFailure.completion.then(() => {
      admittedCompletionSettled = true
    })
    await Promise.resolve()

    // Assert
    await preAdmissionReviewRejected
    await preAdmissionChatAdmissionRejected
    await preAdmissionChatCompletionRejected
    expect(await client.storage.listRuns()).toEqual([])
    expect(admittedCompletionSettled).toBe(false)
    releaseAdmissionStorage()
    await expect(admittedFailure.completion).resolves.toMatchObject({
      id: "admitted-failure",
      status: "failed",
    })
    expect(await client.storage.loadRun("admitted-failure")).toMatchObject({ status: "failed" })
    expect((await client.storage.listRuns()).map((run) => run.id)).toEqual(["admitted-failure"])
  })

  it("admitted_current_generation_cancellation_persists_once_while_stale_cancellation_and_model_output_do_not", async () => {
    // Arrange
    const backingStorage = createMemoryKeyValueStore()
    let authorizedCancellationRunWrites = 0
    const storage: KeyValueStore = {
      get: (key) => backingStorage.get(key),
      set: async (key, value) => {
        if (key.endsWith(":run:authorized-cancellation")) authorizedCancellationRunWrites += 1
        await backingStorage.set(key, value)
      },
      delete: (key) => backingStorage.delete(key),
    }
    const context = await createCodexContext()
    let currentGeneration = true
    const deferredTerminals = new Map<
      string,
      {
        resolve: (output: ReturnType<typeof createCodexOutput>) => void
        reject: (error: Error) => void
      }
    >()
    const bridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: verifiedProvenance,
        receiptId: "test-receipt",
        diagnostics: [],
      })),
      run: vi.fn((request, terminalSchema, _onEvent, onAdmission) => {
        let resolveTerminal!: (output: ReturnType<typeof createCodexOutput>) => void
        let rejectTerminal!: (error: Error) => void
        const terminal = new Promise<ReturnType<typeof createCodexOutput>>((resolve, reject) => {
          resolveTerminal = resolve
          rejectTerminal = reject
        })
        deferredTerminals.set(request.runId, { resolve: resolveTerminal, reject: rejectTerminal })
        const admitted = { runId: request.runId, provenance: verifiedProvenance }
        const admission = Promise.resolve(onAdmission?.(admitted)).then(() => admitted)
        return {
          admission,
          completion: admission.then(() => terminal.then((output) => terminalSchema.parse(output))),
        }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const client = createTauriAiReviewClient({ storage, codexBridge: bridge })

    // Act
    const authorizedCancellation = client.startCodexSafeProfileReview({
      runId: "authorized-cancellation",
      context,
      isCurrentGeneration: () => currentGeneration,
    })
    await vi.waitFor(async () => {
      expect((await client.storage.loadRun("authorized-cancellation"))?.status).toBe("running")
    })
    await authorizedCancellation.cancel()
    deferredTerminals.get("authorized-cancellation")!.resolve(createCodexOutput())
    const cancelledRun = await authorizedCancellation.completion

    const staleModelTerminal = client.startCodexSafeProfileReview({
      runId: "stale-model-terminal",
      context,
      isCurrentGeneration: () => currentGeneration,
    })
    await vi.waitFor(async () => {
      expect((await client.storage.loadRun("stale-model-terminal"))?.status).toBe("running")
    })
    currentGeneration = false
    deferredTerminals.get("stale-model-terminal")!.resolve(createCodexOutput())
    await expect(staleModelTerminal.completion).rejects.toThrow("stale for this generation")
    expect(await client.storage.loadRun("stale-model-terminal")).toMatchObject({
      status: "running",
    })
    expect(await client.storage.loadDiagnostics("stale-model-terminal")).toBeNull()

    currentGeneration = true
    const staleCancellation = client.startCodexSafeProfileReview({
      runId: "stale-cancellation-terminal",
      context,
      isCurrentGeneration: () => currentGeneration,
    })
    await vi.waitFor(async () => {
      expect((await client.storage.loadRun("stale-cancellation-terminal"))?.status).toBe("running")
    })
    currentGeneration = false
    await staleCancellation.cancel()
    deferredTerminals.get("stale-cancellation-terminal")!.reject(new Error("broker cancelled"))

    // Assert
    expect(cancelledRun).toMatchObject({
      id: "authorized-cancellation",
      status: "cancelled",
      summary: null,
      findings: [],
    })
    expect(await client.storage.loadRun("authorized-cancellation")).toEqual(cancelledRun)
    expect(authorizedCancellationRunWrites).toBe(2)
    await expect(staleCancellation.completion).rejects.toThrow("stale for this generation")
    expect(await client.storage.loadRun("stale-cancellation-terminal")).toMatchObject({
      status: "running",
    })
  })

  it("generation_guard_persists_only_authorized_cancellation_terminal_and_discards_stale_model_terminal", async () => {
    // Arrange — the real bridge over a fake broker boundary, the real lifecycle client and real
    // storage. Every run reaches durable admission, then its terminal is released by hand so the
    // case decides what the current UI generation is when the model output finally lands.
    const backingStorage = createMemoryKeyValueStore()
    const runWrites = new Map<string, number>()
    const storage: KeyValueStore = {
      get: (key) => backingStorage.get(key),
      set: async (key, value) => {
        const runId = key.startsWith("ai-review:run:") ? key.slice("ai-review:run:".length) : null
        if (runId) runWrites.set(runId, (runWrites.get(runId) ?? 0) + 1)
        await backingStorage.set(key, value)
      },
      delete: (key) => backingStorage.delete(key),
    }
    const listeners = new Set<(event: { payload: unknown }) => void>()
    const cancelledRunIds: string[] = []
    const emit = (event: Record<string, unknown>): void => {
      for (const listener of [...listeners]) listener({ payload: event })
    }
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      if (command === "codex_safe_profile_capability") {
        return {
          available: true,
          cliVersion: "0.153.4",
          coreControlsVerified: true,
          provenance: verifiedProvenance,
          receiptId: "test-receipt",
          diagnostics: [],
        }
      }
      if (command === "codex_safe_profile_start") {
        const { request } = args as { request: { runId: string } }
        emit({ type: "queued", runId: request.runId })
        emit({ type: "admitted", runId: request.runId, provenance: verifiedProvenance })
        return { runId: request.runId }
      }
      if (command === "codex_safe_profile_cancel") {
        const { request } = args as { request: { runId: string } }
        cancelledRunIds.push(request.runId)
        return null
      }
      throw new Error(`Unexpected Codex safe-profile command: ${command}`)
    }
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke,
        listen: async (_event, handler) => {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      })
    )
    const client = createTauriAiReviewClient({ storage, codexBridge: bridge })
    const context = await createCodexContext()
    const chatThread = {
      id: "generation-guard-thread",
      target: { owner: "acme", repo: "web", number: 42 },
      baseSha: "base-sha",
      headSha: "head-sha",
      kind: "main" as const,
      focusedContext: null,
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createdAt: "2026-09-13T12:00:00.000Z",
    }
    const completedTerminal = (runId: string) => ({
      type: "completed",
      runId,
      result: createCodexOutput(),
      usage: { elapsedMs: 42, toolEventCount: 0 },
      provenance: verifiedProvenance,
    })
    let authorizedGeneration = true
    let staleCompletionGeneration = true
    let staleFailureGeneration = true
    let staleChatGeneration = true
    // A discarded terminal rejects its lifecycle the moment the event lands, so each rejection is
    // captured at creation rather than awaited later as an unhandled one.
    const rejectionOf = (promise: Promise<unknown>): Promise<string> =>
      promise.then(
        () => "resolved",
        (error: unknown) => String(error)
      )

    // Act — an authorized cancellation on the generation that owns the run.
    const authorized = client.startCodexSafeProfileReview({
      runId: "authorized-cancellation",
      context,
      isCurrentGeneration: () => authorizedGeneration,
    })
    await vi.waitFor(async () => {
      expect((await client.storage.loadRun("authorized-cancellation"))?.status).toBe("running")
    })
    await authorized.cancel()
    emit({
      type: "failed",
      runId: "authorized-cancellation",
      code: "cancelled",
      provenance: verifiedProvenance,
    })
    const authorizedTerminal = await authorized.completion

    // A delayed model COMPLETION that lands after the generation was invalidated.
    const staleCompletion = client.startCodexSafeProfileReview({
      runId: "stale-model-completion",
      context,
      isCurrentGeneration: () => staleCompletionGeneration,
    })
    const staleCompletionRejection = rejectionOf(staleCompletion.completion)
    await vi.waitFor(async () => {
      expect((await client.storage.loadRun("stale-model-completion"))?.status).toBe("running")
    })
    staleCompletionGeneration = false
    emit(completedTerminal("stale-model-completion"))

    // A delayed model FAILURE that lands after the generation was invalidated.
    const staleFailure = client.startCodexSafeProfileReview({
      runId: "stale-model-failure",
      context,
      isCurrentGeneration: () => staleFailureGeneration,
    })
    const staleFailureRejection = rejectionOf(staleFailure.completion)
    await vi.waitFor(async () => {
      expect((await client.storage.loadRun("stale-model-failure"))?.status).toBe("running")
    })
    staleFailureGeneration = false
    emit({
      type: "failed",
      runId: "stale-model-failure",
      code: "invalid-output",
      provenance: verifiedProvenance,
    })

    // The same guard on the chat lifecycle: an admitted turn whose model output arrives after
    // invalidation must not become a persisted turn, and must not leave its UI awaiting.
    const staleChat = client.startCodexSafeProfileChat({
      runId: "stale-chat-turn",
      thread: chatThread,
      attachedContext: { scope: "file", path: "src/route.ts" },
      message: "Is the route authorized?",
      prompt: "App-owned scope-bound chat prompt",
      model: null,
      observedProvenance: verifiedProvenance,
      history: [],
      isCurrentGeneration: () => staleChatGeneration,
    })
    const staleChatRejection = rejectionOf(staleChat.completion)
    await staleChat.admission
    staleChatGeneration = false
    emit({
      ...completedTerminal("stale-chat-turn"),
      result: {
        message: "The route authorization branch is untested.",
        findingCandidate: null,
        reportedModel: null,
      },
    })

    // Assert — only the authorized cancellation became a terminal record, written exactly twice
    // (its admitted `running` record and its one cancelled terminal).
    const expectedAuthorizedWrites = 2
    const expectedStoredRunIds = [
      "authorized-cancellation",
      "stale-model-completion",
      "stale-model-failure",
    ]

    expect(authorizedTerminal).toMatchObject({
      id: "authorized-cancellation",
      status: "cancelled",
      summary: null,
      findings: [],
    })
    expect(await client.storage.loadRun("authorized-cancellation")).toEqual(authorizedTerminal)
    expect(runWrites.get("authorized-cancellation")).toBe(expectedAuthorizedWrites)
    expect(cancelledRunIds).toEqual(["authorized-cancellation"])

    expect(await staleCompletionRejection).toContain("stale for this generation")
    expect(await staleFailureRejection).toContain("stale for this generation")
    expect(await client.storage.loadRun("stale-model-completion")).toMatchObject({
      status: "running",
      summary: null,
    })
    expect(await client.storage.loadRun("stale-model-failure")).toMatchObject({
      status: "running",
      summary: null,
    })
    expect(await client.storage.loadDiagnostics("stale-model-completion")).toBeNull()
    expect(await client.storage.loadDiagnostics("stale-model-failure")).toBeNull()
    expect(runWrites.get("stale-model-completion")).toBe(1)
    expect(runWrites.get("stale-model-failure")).toBe(1)

    // The stale chat turn settles instead of hanging, and writes nothing at all.
    expect(await staleChatRejection).toContain(
      "Codex safe-profile chat was cancelled before broker admission"
    )
    expect((await client.storage.listRuns()).map((run) => run.id).sort()).toEqual(
      expectedStoredRunIds
    )
  })

  it("exact_observed_provenance_fingerprint_invalidates_context_consent_and_terminal_projection", async () => {
    // Arrange
    const changedProvenance = {
      ...verifiedProvenance,
      provenanceFingerprint: "e".repeat(64),
    }
    const context = await createCodexContext()
    const changedContext = await createCodexContext(null, changedProvenance)
    const storage = createMemoryKeyValueStore()
    const bridge: CodexSafeProfileBridge = {
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: verifiedProvenance,
        receiptId: "test-receipt",
        diagnostics: [],
      })),
      run: vi.fn((request, terminalSchema, onEvent, onAdmission) => {
        const admitted = { runId: request.runId, provenance: verifiedProvenance }
        const admission = Promise.resolve(onAdmission?.(admitted)).then(() => admitted)
        const completion = admission.then(async () => {
          await onEvent?.({
            type: "completed",
            runId: request.runId,
            result: createCodexOutput(),
            usage: { elapsedMs: 1, toolEventCount: 0 },
            provenance: changedProvenance,
          })
          return terminalSchema.parse(createCodexOutput())
        })
        return { admission, completion }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const client = createTauriAiReviewClient({ storage, codexBridge: bridge })

    // Act
    const terminal = client.startCodexSafeProfileReview({
      runId: "provenance-terminal-mismatch",
      context,
    }).completion
    const capabilityMismatch = createTauriAiReviewClient({
      storage: createMemoryKeyValueStore(),
      codexBridge: {
        ...bridge,
        capability: vi.fn(async () => ({
          available: true,
          cliVersion: "0.153.4",
          coreControlsVerified: true,
          provenance: changedProvenance,
          receiptId: "changed-receipt",
          diagnostics: [],
        })),
      },
    }).startCodexSafeProfileReview({ runId: "provenance-capability-mismatch", context }).completion

    // Assert
    expect(changedContext.inputFingerprint).not.toBe(context.inputFingerprint)
    expect(changedContext.contextSecurityFingerprint).not.toBe(context.contextSecurityFingerprint)
    await expect(terminal).rejects.toThrow("terminal provenance does not match")
    await expect(capabilityMismatch).rejects.toThrow("capability provenance does not match")
    expect(await client.storage.loadRun("provenance-terminal-mismatch")).toMatchObject({
      status: "running",
      observedProvenance: verifiedProvenance,
    })
    expect(bridge.run).toHaveBeenCalledWith(
      expect.objectContaining({ observedProvenance: verifiedProvenance }),
      expect.anything(),
      expect.any(Function),
      expect.any(Function)
    )
  })

  it("accepts only the process-free test-only fake provider", () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const fakeProvider = createFakeAiReviewProvider()
    const nonFakeProvider: AppAiReviewProvider = {
      ...fakeProvider,
      id: "claude",
    }

    // Act
    const createWithNonFakeProvider = (): unknown =>
      createTauriAiReviewClient({ storage, fakeProvider: nonFakeProvider })

    // Assert
    expect(createWithNonFakeProvider).toThrow(
      "The Tauri AI review lifecycle accepts only the test-only fake provider"
    )
  })
})
