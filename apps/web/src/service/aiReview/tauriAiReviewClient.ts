import {
  type AiChatMessage,
  type AiChatThread,
  type AiReviewEvent,
  type AiReviewRun,
  type AiReviewTarget,
  type ChatContextReference,
  type ChatTurnOutput,
  type ObservedCodexSafeProfileProvenance,
  type ReviewProfile,
  aiReviewEventSchema,
  chatTurnOutputSchema,
  codexSafeProfileChatTerminalSchema,
  codexSafeProfileReviewTerminalSchema,
  providerCapabilitiesSchema,
  reviewRunInputSchema,
  reviewRunOutputSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

import type { RevisionPinnedReviewPatches } from "@/utils/aiReview/findingValidation"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import type { CodexReviewContext } from "./codexReviewContext"
import {
  type CodexSafeProfileBridge,
  type CodexSafeProfileCapability,
  CodexSafeProfileProvenanceMismatchError,
  createCodexSafeProfileBridge,
} from "./codexSafeProfileBridge"
import { createFakeAiReviewProvider } from "./providers/fakeProvider"
import type { AppAiReviewProvider } from "./providers/provider"
import { createAiReviewRunStorage } from "./runStorage"
import { createAiReviewSettingsStorage } from "./settingsStorage"

const FAKE_CONFIGURATION = {
  provider: "fake" as const,
  executablePath: null,
  selectedModel: null,
}

const revisionPinnedReviewPatchesSchema = z.object({
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  patches: z.record(z.string(), z.string()),
})

const startFakeReviewInputSchema = reviewRunInputSchema
  .extend({
    promptVersion: z.string().min(1),
    recordedPatches: revisionPinnedReviewPatchesSchema,
  })
  .superRefine((input, context) => {
    if (input.recordedPatches.baseSha !== input.baseSha) {
      context.addIssue({
        code: "custom",
        path: ["recordedPatches", "baseSha"],
        message: "Recorded patches must use the review input base SHA",
      })
    }
    if (input.recordedPatches.headSha !== input.headSha) {
      context.addIssue({
        code: "custom",
        path: ["recordedPatches", "headSha"],
        message: "Recorded patches must use the review input head SHA",
      })
    }
  })

export type StartFakeReviewInput = {
  runId: string
  target: AiReviewTarget
  baseSha: string
  headSha: string
  inputFingerprint: string
  contextSecurityFingerprint: string
  profile: ReviewProfile
  promptVersion: string
  recordedPatches: RevisionPinnedReviewPatches
}

export type TauriAiReviewLifecycle = {
  runId: string
  completion: Promise<AiReviewRun>
  cancel(): Promise<void>
}

export type StartCodexSafeProfileChatInput = {
  runId: string
  // UI-owned only: latches cancellation or identity invalidation before broker admission.
  isCurrentGeneration?: () => boolean
  thread: AiChatThread
  attachedContext: ChatContextReference
  message: string
  prompt: string
  model: string | null
  observedProvenance: ObservedCodexSafeProfileProvenance
  history: readonly AiChatMessage[]
  onEvent?: (event: AiReviewEvent) => void
}

export type TauriAiChatLifecycle = {
  runId: string
  // Resolves only after Rust has acknowledged an active admission with the exact observed
  // provenance. Chat UI must not create a thread or persist user content before this boundary.
  admission?: Promise<void>
  completion: Promise<ChatTurnOutput>
  cancel(): Promise<void>
}

export type StartCodexSafeProfileReviewInput = {
  runId: string
  context: CodexReviewContext
  // UI-owned only: this is checked around capability/admission and never crosses into Rust.
  isCurrentGeneration?: () => boolean
  // Progress crosses the lifecycle boundary only as a sanitized app-owned event. The broker's
  // JSONL, stderr, prompt, and transient run paths remain unavailable to UI callers.
  onEvent?: (event: AiReviewEvent) => void
}

export type TauriAiReviewClientDeps = {
  storage: KeyValueStore
  fakeProvider?: AppAiReviewProvider
  codexBridge?: CodexSafeProfileBridge
  now?: () => string
}

function codexSafeProfilePrKey(target: AiReviewTarget): string {
  // The app derives queue identity from its already-validated review target. It is admission
  // metadata only and is never passed to Codex as a path, argument, or working directory.
  return `${target.owner}/${target.repo}#${target.number}`
}

type BrokerObservedUsage = { elapsedMs: number; toolEventCount: number }

function hasExactProvenance(
  actual: ObservedCodexSafeProfileProvenance,
  expected: ObservedCodexSafeProfileProvenance
): boolean {
  return (
    actual.executableIdentityDigest === expected.executableIdentityDigest &&
    actual.cliVersion === expected.cliVersion &&
    actual.helpDigest === expected.helpDigest &&
    actual.safeProfileRevision === expected.safeProfileRevision &&
    actual.provenanceFingerprint === expected.provenanceFingerprint
  )
}

function requireVerifiedCodexProvenance(capability: CodexSafeProfileCapability) {
  if (
    !capability.available ||
    !capability.coreControlsVerified ||
    !capability.cliVersion ||
    !capability.provenance ||
    !capability.receiptId ||
    !capability.provenance.provenanceFingerprint ||
    capability.provenance.cliVersion !== capability.cliVersion
  ) {
    throw new Error("Codex safe-profile broker provenance receipt is unavailable")
  }
  return { receiptId: capability.receiptId, provenance: capability.provenance }
}

function appDerivedUsage(observation: BrokerObservedUsage) {
  return {
    elapsedMs: observation.elapsedMs,
    // Prompt-only Codex has no parent/nested agent, command, or tool authority. The only count
    // retained comes from the broker-owned terminal observation; tokens and cost remain unknown.
    parentAgentCount: 0,
    nestedAgentCount: 0,
    toolEventCount: observation.toolEventCount,
    approvedCommandCount: 0,
    inputTokens: null,
    outputTokens: null,
    providerCost: null,
  }
}

function emptyRunFields() {
  return {
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

function isCancellationError(error: unknown, cancellationRequested: boolean): boolean {
  return (
    cancellationRequested || (error instanceof Error && error.name === "FakeProviderCancelledError")
  )
}

function isInvalidCodexOutputError(error: unknown): boolean {
  return (
    error instanceof z.ZodError ||
    (error instanceof Error &&
      (error.message.includes("Codex safe-profile run failed: invalid-output") ||
        error.message.includes("Codex safe-profile terminal usage observation is missing")))
  )
}

function codexSanitizedEvent(event: { type: string; runId: string }): AiReviewEvent | null {
  switch (event.type) {
    case "queued":
      return {
        type: "progress",
        runId: event.runId,
        message: "Codex safe-profile is queued for broker admission",
      }
    case "started":
      return {
        type: "progress",
        runId: event.runId,
        message: "Codex safe-profile started",
      }
    case "progress":
      return {
        type: "progress",
        runId: event.runId,
        message: "Codex safe-profile is processing bounded review context",
      }
    case "completed":
      return { type: "completed", runId: event.runId }
    default:
      return null
  }
}

async function rememberCompletedCodexModels(
  storage: KeyValueStore,
  run: AiReviewRun
): Promise<void> {
  if (run.provider !== "codex" || run.status !== "completed") return

  // A model ID becomes a suggestion only after the app has schema-validated and persisted the
  // completed terminal run. Retain the requested and provider-reported IDs when they differ.
  const successfulModels = new Set([run.selectedModel, run.reportedModel])
  try {
    for (const modelId of successfulModels) {
      if (modelId !== null) {
        await createAiReviewSettingsStorage(storage).rememberSuccessfulModel("codex", modelId)
      }
    }
  } catch {
    // Model-memory persistence is supplemental and must not rewrite an established terminal run.
  }
}

async function savePermittedDiagnostics(
  storage: ReturnType<typeof createAiReviewRunStorage>,
  runId: string,
  sanitizedEvents: AiReviewEvent[],
  generationGuard?: () => boolean
): Promise<void> {
  try {
    await storage.saveDiagnostics(
      {
        runId,
        sanitizedEvents,
        rawModelOutputPermitted: false,
        rawModelOutput: null,
      },
      generationGuard
    )
  } catch {
    // Diagnostics are permitted supplemental data; failure cannot rewrite an immutable terminal run.
  }
}

// The desktop-only lifecycle keeps deterministic fake tests separate while routing production
// Codex only through the typed Rust safe-profile bridge. Neither path exposes a shell, executable,
// arguments, working directory, environment, command, MCP, or tool request to the webview.
export function createTauriAiReviewClient(deps: TauriAiReviewClientDeps) {
  const provider = deps.fakeProvider ?? createFakeAiReviewProvider()
  const codexBridge = deps.codexBridge ?? createCodexSafeProfileBridge()
  const storage = createAiReviewRunStorage(deps.storage)
  const now = deps.now ?? (() => new Date().toISOString())

  if (provider.id !== "fake" || provider.availability !== "test-only") {
    throw new Error("The Tauri AI review lifecycle accepts only the test-only fake provider")
  }

  function startFakeReview(input: StartFakeReviewInput): TauriAiReviewLifecycle {
    const parsedInput = startFakeReviewInputSchema.parse({
      ...input,
      configuration: FAKE_CONFIGURATION,
    })
    let cancellationRequested = false
    const sanitizedEvents: AiReviewEvent[] = []

    const completion = (async (): Promise<AiReviewRun> => {
      const capabilities = providerCapabilitiesSchema.parse(
        await provider.probe(parsedInput.configuration)
      )
      if (!capabilities.available || !capabilities.cliVersion) {
        throw new Error("The test-only fake provider is unavailable")
      }

      const runningRun: AiReviewRun = {
        id: parsedInput.runId,
        target: parsedInput.target,
        baseSha: parsedInput.baseSha,
        headSha: parsedInput.headSha,
        inputFingerprint: parsedInput.inputFingerprint,
        contextSecurityFingerprint: parsedInput.contextSecurityFingerprint,
        provider: "fake",
        selectedModel: parsedInput.configuration.selectedModel,
        cliVersion: capabilities.cliVersion,
        promptVersion: parsedInput.promptVersion,
        profile: parsedInput.profile,
        status: "running",
        createdAt: now(),
        completedAt: null,
        ...emptyRunFields(),
      }
      await storage.createRun(runningRun)

      try {
        const output = await provider.review(parsedInput, async (event) => {
          const parsedEvent = aiReviewEventSchema.parse(event)
          if (parsedEvent.runId !== parsedInput.runId) {
            throw new Error("Fake provider event does not belong to the active run")
          }
          sanitizedEvents.push(parsedEvent)
        })
        const terminal = await storage.finalizeRun(
          runningRun.id,
          output,
          parsedInput.recordedPatches,
          now()
        )
        await savePermittedDiagnostics(storage, terminal.run.id, sanitizedEvents)
        return terminal.run
      } catch (error) {
        const terminalRun = await storage.terminateRun(
          runningRun.id,
          isCancellationError(error, cancellationRequested) ? "cancelled" : "failed",
          now()
        )
        await savePermittedDiagnostics(storage, terminalRun.id, sanitizedEvents)
        return terminalRun
      }
    })()

    return {
      runId: parsedInput.runId,
      completion,
      async cancel(): Promise<void> {
        cancellationRequested = true
        await provider.cancel(parsedInput.runId)
      },
    }
  }

  function startCodexSafeProfileReview(
    input: StartCodexSafeProfileReviewInput
  ): TauriAiReviewLifecycle {
    let brokerUsage: BrokerObservedUsage | null = null
    const runId = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(input.runId)
    const context = input.context
    let cancellationRequested = false
    let terminalProvenanceMismatch = false
    const sanitizedEvents: AiReviewEvent[] = []
    const isCurrentGeneration = () => input.isCurrentGeneration?.() !== false
    const isCancelled = () => cancellationRequested || !isCurrentGeneration()
    // An explicit cancellation may become the active run's terminal record, but invalidating the
    // UI generation may not. Keep these latches separate so a delayed model terminal cannot turn
    // a stale run into completed, failed, or cancelled storage.
    const terminalStorageGenerationGuard = () => isCurrentGeneration()
    const ensureNotCancelled = () => {
      if (isCancelled()) {
        throw new Error("Codex safe-profile review was cancelled before broker admission")
      }
    }

    const completion = (async (): Promise<AiReviewRun> => {
      const capability = await codexBridge.capability()
      ensureNotCancelled()
      const verifiedProvenance = requireVerifiedCodexProvenance(capability)
      if (!hasExactProvenance(verifiedProvenance.provenance, context.observedProvenance)) {
        throw new CodexSafeProfileProvenanceMismatchError("capability")
      }
      ensureNotCancelled()

      const runningRun: AiReviewRun = {
        id: runId,
        target: context.target,
        baseSha: context.baseSha,
        headSha: context.headSha,
        inputFingerprint: context.inputFingerprint,
        contextSecurityFingerprint: context.contextSecurityFingerprint,
        provider: "codex",
        selectedModel: context.selectedModel,
        cliVersion: verifiedProvenance.provenance.cliVersion,
        observedProvenance: verifiedProvenance.provenance,
        promptVersion: context.promptVersion,
        profile: context.profile,
        status: "running",
        createdAt: now(),
        completedAt: null,
        ...emptyRunFields(),
      }
      let admissionAcknowledged = false

      try {
        ensureNotCancelled()
        const bridgeRun = codexBridge.run(
          {
            runId,
            prKey: codexSafeProfilePrKey(context.target),
            operation: "review",
            prompt: context.prompt,
            model: context.selectedModel,
            provenanceReceiptId: verifiedProvenance.receiptId,
            observedProvenance: context.observedProvenance,
            isCancelled,
          },
          codexSafeProfileReviewTerminalSchema,
          (event) => {
            if (
              (event.type === "completed" || event.type === "failed") &&
              event.provenance !== undefined &&
              event.provenance !== null &&
              !hasExactProvenance(event.provenance, context.observedProvenance)
            ) {
              terminalProvenanceMismatch = true
              return
            }
            if (event.type === "completed") brokerUsage = event.usage
            const sanitizedEvent = codexSanitizedEvent(event)
            if (!sanitizedEvent) return
            sanitizedEvents.push(sanitizedEvent)
            input.onEvent?.(sanitizedEvent)
          },
          async (admission) => {
            ensureNotCancelled()
            if (!hasExactProvenance(admission.provenance, context.observedProvenance)) {
              throw new CodexSafeProfileProvenanceMismatchError("admission")
            }
            await storage.createRun(runningRun, terminalStorageGenerationGuard)
            if (!terminalStorageGenerationGuard()) {
              throw new Error("Codex safe-profile review generation changed during admission")
            }
            admissionAcknowledged = true
          }
        )
        const output = await bridgeRun.completion
        if (terminalProvenanceMismatch) {
          throw new CodexSafeProfileProvenanceMismatchError("terminal")
        }
        // A broker terminal can arrive after the UI has invalidated its generation or requested
        // cancellation. It is never model output for the current generation in that case.
        ensureNotCancelled()
        const terminal = await storage.finalizeRun(
          runId,
          reviewRunOutputSchema.parse({
            ...output,
            // The model cannot report coverage or usage. Coverage is the admitted snapshot and
            // usage comes only from broker-observed terminal facts.
            coverage: context.coverage,
            usage: appDerivedUsage(
              brokerUsage ??
                (() => {
                  throw new Error("Codex safe-profile terminal usage observation is missing")
                })()
            ),
          }),
          context.recordedPatches,
          now(),
          context.selectedJiraCriteria,
          terminalStorageGenerationGuard
        )
        if (!sanitizedEvents.some((event) => event.type === "completed")) {
          sanitizedEvents.push({ type: "completed", runId })
        }
        await rememberCompletedCodexModels(deps.storage, terminal.run)
        await savePermittedDiagnostics(
          storage,
          terminal.run.id,
          sanitizedEvents,
          terminalStorageGenerationGuard
        )
        return terminal.run
      } catch (error) {
        // A broker failure before acknowledgement has no local running record to mutate.
        if (!admissionAcknowledged || error instanceof CodexSafeProfileProvenanceMismatchError) {
          throw error
        }
        const terminalRun = isInvalidCodexOutputError(error)
          ? (
              await storage.finalizeRun(
                runId,
                undefined,
                context.recordedPatches,
                now(),
                context.selectedJiraCriteria,
                terminalStorageGenerationGuard
              )
            ).run
          : await storage.terminateRun(
              runId,
              isCancellationError(error, isCancelled()) ? "cancelled" : "failed",
              now(),
              terminalStorageGenerationGuard
            )
        await savePermittedDiagnostics(
          storage,
          terminalRun.id,
          sanitizedEvents,
          terminalStorageGenerationGuard
        )
        return terminalRun
      }
    })()

    return {
      runId,
      completion,
      async cancel(): Promise<void> {
        cancellationRequested = true
        await codexBridge.cancel(runId)
      },
    }
  }

  function startCodexSafeProfileChat(input: StartCodexSafeProfileChatInput): TauriAiChatLifecycle {
    let brokerUsage: BrokerObservedUsage | null = null
    const runId = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(input.runId)
    // Parse all provider-neutral persisted data before it becomes part of a fresh, ephemeral
    // prompt. No provider session ID is accepted or returned by this lifecycle.
    const thread = z.object({ id: z.string().min(1) }).parse(input.thread)
    const attachedContext = z
      .discriminatedUnion("scope", [
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
      .parse(input.attachedContext)
    const message = z
      .string()
      .min(1)
      .max(64 * 1024)
      .parse(input.message)
    const prompt = z
      .string()
      .min(1)
      .max(512 * 1024)
      .parse(input.prompt)
    const history = input.history.map((storedMessage) =>
      z
        .object({
          threadId: z.string().min(1),
          contextSecurityFingerprint: z.string().min(1),
        })
        .passthrough()
        .parse(storedMessage)
    )
    if (history.some((storedMessage) => storedMessage.threadId !== thread.id)) {
      throw new Error("Codex safe-profile chat history must belong to its selected thread")
    }

    let cancellationRequested = false
    let admissionPending = true
    let acknowledgeAdmission: () => void = () => {}
    let rejectAdmission: (error: Error) => void = () => {}
    const admission = new Promise<void>((resolve, reject) => {
      acknowledgeAdmission = () => {
        if (!admissionPending) return
        admissionPending = false
        resolve()
      }
      rejectAdmission = (error) => {
        if (!admissionPending) return
        admissionPending = false
        reject(error)
      }
    })
    let rejectPreAdmissionCancellation: (error: Error) => void = () => {}
    const preAdmissionCancellation = new Promise<never>((_resolve, reject) => {
      rejectPreAdmissionCancellation = reject
    })
    const isCancelled = () => cancellationRequested || input.isCurrentGeneration?.() === false
    const ensureNotCancelled = () => {
      if (isCancelled()) {
        throw new Error("Codex safe-profile chat was cancelled before broker admission")
      }
    }
    const completionWork = (async (): Promise<ChatTurnOutput> => {
      try {
        const capability = await codexBridge.capability()
        // Capability probing may be in flight when the reviewer revokes consent. Reject the
        // pending admission as well as completion so its UI caller cannot remain suspended.
        ensureNotCancelled()
        const verifiedProvenance = requireVerifiedCodexProvenance(capability)
        if (!hasExactProvenance(verifiedProvenance.provenance, input.observedProvenance)) {
          throw new CodexSafeProfileProvenanceMismatchError("capability")
        }
        ensureNotCancelled()
        const bridgeRun = codexBridge.run(
          {
            runId,
            prKey: codexSafeProfilePrKey(input.thread.target),
            operation: "chat",
            prompt,
            model: input.model,
            provenanceReceiptId: verifiedProvenance.receiptId,
            observedProvenance: input.observedProvenance,
            isCancelled,
          },
          codexSafeProfileChatTerminalSchema,
          (event) => {
            if (event.type === "completed") brokerUsage = event.usage
            const sanitizedEvent = codexSanitizedEvent(event)
            if (sanitizedEvent) input.onEvent?.(sanitizedEvent)
          },
          (acknowledgement) => {
            if (!hasExactProvenance(acknowledgement.provenance, input.observedProvenance)) {
              throw new CodexSafeProfileProvenanceMismatchError("admission")
            }
            ensureNotCancelled()
          }
        )
        void bridgeRun.admission.then(
          () => acknowledgeAdmission(),
          (error: unknown) =>
            rejectAdmission(
              error instanceof Error ? error : new Error("Codex chat admission failed")
            )
        )
        const terminal = await bridgeRun.completion
        // Unlike a review run, chat has no terminal record of its own. A cancellation therefore
        // rejects the ephemeral result so its caller cannot append model output after cancellation
        // or generation invalidation.
        ensureNotCancelled()
        return chatTurnOutputSchema.parse({
          ...terminal,
          // Chat usage is broker-observed, not a model-controlled terminal field.
          usage: appDerivedUsage(
            brokerUsage ??
              (() => {
                throw new Error("Codex safe-profile terminal usage observation is missing")
              })()
          ),
        })
      } catch (error) {
        const admissionError =
          error instanceof Error ? error : new Error("Codex chat admission failed")
        rejectAdmission(admissionError)
        throw admissionError
      }
    })()
    // Cancellation cannot rely on a capability probe, listener registration, or broker terminal
    // returning. While admission is pending it settles both public lifecycle promises immediately.
    const completion = Promise.race([completionWork, preAdmissionCancellation])

    return {
      runId,
      admission,
      completion,
      async cancel(): Promise<void> {
        cancellationRequested = true
        if (admissionPending) {
          const cancellationError = new Error(
            "Codex safe-profile chat was cancelled before broker admission"
          )
          rejectAdmission(cancellationError)
          rejectPreAdmissionCancellation(cancellationError)
        }
        await codexBridge.cancel(runId)
      },
    }
  }

  return { startFakeReview, startCodexSafeProfileReview, startCodexSafeProfileChat, storage }
}

export type TauriAiReviewClient = ReturnType<typeof createTauriAiReviewClient>

// This is called by desktop bootstrap before React renders stored history. Rust returns only
// marker/PID/start-identity-resolved Codex IDs from its pre-webview recovery; local storage must
// leave every other Codex `running` record untouched because it may still own a live process.
export async function recoverInterruptedTauriAiReviewRuns(
  storage: KeyValueStore,
  completedAt = new Date().toISOString(),
  safelyRecoveredCodexRunIds: readonly string[] = []
): Promise<AiReviewRun[]> {
  return createAiReviewRunStorage(storage).recoverInterruptedRuns(
    completedAt,
    safelyRecoveredCodexRunIds
  )
}

// Both recovery commands take opaque broker-owned IDs only, so bootstrap needs nothing but the
// invoke seam. Injecting it keeps the composition below testable without the Tauri runtime.
export type CodexRecoveryInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>

export type CodexRecoveryDeps = {
  invoke: CodexRecoveryInvoke
  completedAt: string
}

async function loadTauriInvoke(): Promise<CodexRecoveryInvoke> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke
}

export async function loadSafelyRecoveredCodexRunIds(
  invoke?: CodexRecoveryInvoke
): Promise<string[]> {
  const invokeCommand = invoke ?? (await loadTauriInvoke())
  const runIds = await invokeCommand("codex_safe_profile_safely_recovered_run_ids")
  if (!Array.isArray(runIds) || !runIds.every((runId) => typeof runId === "string")) {
    throw new Error("Codex safe-profile recovery returned invalid run IDs")
  }
  return runIds
}

export async function acknowledgeRecoveredCodexRuns(
  runIds: readonly string[],
  invoke?: CodexRecoveryInvoke
): Promise<void> {
  const invokeCommand = invoke ?? (await loadTauriInvoke())
  await invokeCommand("codex_safe_profile_acknowledge_recovered_runs", { runIds: [...runIds] })
}

// Rust keeps each recovered run's terminal receipt until this acknowledges it, so the local
// interruption is always persisted before its evidence can be deleted. An ID is acknowledged only
// once its local outcome is settled: a record that is now terminal, or no record at all — the app
// crashed between Rust's admission and the webview's first write, so there is nothing that could
// ever be interrupted and holding the receipt would re-report it on every startup forever. A
// record that still reads `running`, one that cannot be read, and a failed storage read all keep
// their evidence for a later startup.
export async function recoverAndAcknowledgeCodexRuns(
  storage: KeyValueStore,
  deps: Partial<CodexRecoveryDeps> = {}
): Promise<AiReviewRun[]> {
  const invoke = deps.invoke ?? (await loadTauriInvoke())
  const reportedRunIds = await loadSafelyRecoveredCodexRunIds(invoke)
  const interrupted = await recoverInterruptedTauriAiReviewRuns(
    storage,
    deps.completedAt,
    reportedRunIds
  )

  const runStorage = createAiReviewRunStorage(storage)
  const durablyRecoveredRunIds: string[] = []
  for (const runId of reportedRunIds) {
    try {
      const record = await runStorage.readRunRecord(runId)
      if (record.state === "missing") durablyRecoveredRunIds.push(runId)
      else if (record.state === "stored" && record.run.status !== "running") {
        durablyRecoveredRunIds.push(runId)
      }
    } catch {
      // A read failure is not proof of absence, so this receipt survives to the next startup.
    }
  }
  if (durablyRecoveredRunIds.length === 0) return interrupted

  try {
    await acknowledgeRecoveredCodexRuns(durablyRecoveredRunIds, invoke)
  } catch {
    // A failed acknowledgement is not a startup failure: the receipt stays and Rust reports the
    // run again on the next startup.
  }
  return interrupted
}

let client: TauriAiReviewClient | null = null

// Bootstrap injects the app's one Tauri Store before React mounts. Keeping this separate from
// PrClient prevents AI lifecycle authority from widening the existing GitHub data boundary.
export function initTauriAiReviewClient(deps: TauriAiReviewClientDeps): void {
  client = createTauriAiReviewClient(deps)
}

export function getTauriAiReviewClient(): TauriAiReviewClient {
  if (!client) throw new Error("tauri AI review client: call initTauriAiReviewClient(deps) first")
  return client
}
