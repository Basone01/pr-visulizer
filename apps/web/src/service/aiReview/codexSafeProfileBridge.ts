import {
  type ObservedCodexSafeProfileProvenance,
  codexSafeProfileChatTerminalSchema,
  codexSafeProfileReviewTerminalSchema,
  observedCodexSafeProfileProvenanceSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

// Rust enforces the release compatibility facts. The bridge never derives availability from a
// mutable runtime-proof flag; it only carries the broker-issued opaque receipt.
const codexSafeProfileCapabilitySchema = z.object({
  available: z.boolean(),
  // Rust observes this only from the broker-resolved executable's bounded fixed probe. It is
  // diagnostic data; only a matching opaque receipt permits the typed start command.
  cliVersion: z.string().min(1).nullable(),
  coreControlsVerified: z.boolean(),
  provenance: z
    .object({
      executableIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
      cliVersion: z.string().min(1),
      helpDigest: z.string().regex(/^[a-f0-9]{64}$/),
      safeProfileRevision: z.string().min(1),
      provenanceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .nullable()
    .optional(),
  receiptId: z.string().min(1).max(128).nullable().optional(),
  diagnostics: z.array(z.string().min(1)),
})
export type CodexSafeProfileCapability = z.infer<typeof codexSafeProfileCapabilitySchema>

const codexSafeProfileObservedProvenanceSchema = z
  .object({
    executableIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    cliVersion: z.string().min(1),
    helpDigest: z.string().regex(/^[a-f0-9]{64}$/),
    safeProfileRevision: z.string().min(1),
    provenanceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

const codexSafeProfileEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queued"), runId: z.string().min(1) }),
  z.object({
    type: z.literal("admitted"),
    runId: z.string().min(1),
    provenance: codexSafeProfileObservedProvenanceSchema,
  }),
  z.object({
    type: z.literal("started"),
    runId: z.string().min(1),
    provenance: codexSafeProfileObservedProvenanceSchema.nullable().optional(),
  }),
  z.object({ type: z.literal("progress"), runId: z.string().min(1) }),
  z.object({
    type: z.literal("completed"),
    runId: z.string().min(1),
    result: z.unknown(),
    // The broker, not the model, observes these terminal facts. Unknown token/cost fields never
    // cross this event boundary and stay null in app-owned usage.
    usage: z
      .object({
        elapsedMs: z.number().int().nonnegative(),
        toolEventCount: z.number().int().nonnegative(),
      })
      .strict(),
    provenance: codexSafeProfileObservedProvenanceSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("failed"),
    runId: z.string().min(1),
    code: z.string().min(1),
    provenance: codexSafeProfileObservedProvenanceSchema.nullable().optional(),
  }),
])
export type CodexSafeProfileEvent = z.infer<typeof codexSafeProfileEventSchema>

const codexSafeProfileStartResponseSchema = z.object({ runId: z.string().min(1) })

export type CodexSafeProfileOperation = "review" | "chat"

export type CodexSafeProfilePromptRequest = {
  runId: string
  // This app-derived identity is queue-admission data only; Rust never uses it as a path or
  // executable/workdir selector.
  prKey: string
  // Closed operation selector only: Rust maps it to one embedded schema. This is never a schema
  // path, executable, argv, workdir, environment, command, MCP, or tool request.
  operation: CodexSafeProfileOperation
  prompt: string
  model: string | null
  // Opaque capability receipt only; it cannot name an executable or profile input.
  provenanceReceiptId?: string
  // App-owned context identity from the observed capability receipt. It is checked locally
  // against capability/admission/terminal observations and never expands Rust's fixed request.
  observedProvenance: ObservedCodexSafeProfileProvenance
  // Lifecycle-owned only: this closure is never serialized across the Rust boundary. It latches a
  // cancellation or invalidated UI generation before listener registration and broker admission.
  isCancelled?: () => boolean
}

export type CodexSafeProfileBridgeDeps = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
  listen(
    event: "codex-safe-profile-event",
    handler: (event: { payload: unknown }) => void
  ): Promise<() => void>
}

export type CodexSafeProfileAdmission = {
  runId: string
  provenance: z.infer<typeof codexSafeProfileObservedProvenanceSchema>
}

// Admission and completion are deliberately separate settlements. A terminal observed before
// Rust's durable `admitted` event rejects both; an admitted terminal cannot settle completion
// until its app-owned admission callback has durably completed.
export type CodexSafeProfileRun<T> = {
  admission: Promise<CodexSafeProfileAdmission>
  completion: Promise<T>
}

export class CodexSafeProfileProvenanceMismatchError extends Error {
  constructor(phase: "capability" | "admission" | "terminal") {
    super(`Codex safe-profile ${phase} provenance does not match the context-bound receipt`)
    this.name = "CodexSafeProfileProvenanceMismatchError"
  }
}

function hasExactProvenance(
  actual: ObservedCodexSafeProfileProvenance | null | undefined,
  expected: ObservedCodexSafeProfileProvenance
): actual is ObservedCodexSafeProfileProvenance {
  return (
    actual !== null &&
    actual !== undefined &&
    actual.executableIdentityDigest === expected.executableIdentityDigest &&
    actual.cliVersion === expected.cliVersion &&
    actual.helpDigest === expected.helpDigest &&
    actual.safeProfileRevision === expected.safeProfileRevision &&
    actual.provenanceFingerprint === expected.provenanceFingerprint
  )
}

export type CodexSafeProfileBridge = {
  capability(): Promise<CodexSafeProfileCapability>
  run<T>(
    request: CodexSafeProfilePromptRequest,
    terminalSchema: z.ZodType<T>,
    onEvent?: (event: CodexSafeProfileEvent) => void | Promise<void>,
    onAdmission?: (admission: CodexSafeProfileAdmission) => void | Promise<void>
  ): CodexSafeProfileRun<T>
  cancel(runId: string): Promise<void>
}

async function createTauriBridgeDeps(): Promise<CodexSafeProfileBridgeDeps> {
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ])
  return { invoke, listen }
}

// This bridge names only the three fixed Rust commands. Its request never includes an executable,
// argv, working directory, environment, command, tool, or provider configuration path.
export function createCodexSafeProfileBridge(
  depsPromise: Promise<CodexSafeProfileBridgeDeps> = createTauriBridgeDeps()
): CodexSafeProfileBridge {
  return {
    async capability(): Promise<CodexSafeProfileCapability> {
      const deps = await depsPromise
      return codexSafeProfileCapabilitySchema.parse(
        await deps.invoke("codex_safe_profile_capability")
      )
    },

    run<T>(
      request: CodexSafeProfilePromptRequest,
      terminalSchema: z.ZodType<T>,
      onEvent?: (event: CodexSafeProfileEvent) => void | Promise<void>,
      onAdmission?: (admission: CodexSafeProfileAdmission) => void | Promise<void>
    ): CodexSafeProfileRun<T> {
      let resolveAdmission!: (admission: CodexSafeProfileAdmission) => void
      let rejectAdmission!: (error: Error) => void
      let resolveCompletion!: (result: T) => void
      let rejectCompletion!: (error: Error) => void
      const admission = new Promise<CodexSafeProfileAdmission>((resolve, reject) => {
        resolveAdmission = resolve
        rejectAdmission = reject
      })
      const completion = new Promise<T>((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
      // The review caller only consumes completion today. Mark the separate admission rejection
      // handled while preserving the rejected promise for callers that do await it.
      void admission.catch(() => undefined)

      let unlisten: (() => void) | null = null
      let terminalSeen = false
      let admitted: CodexSafeProfileAdmission | null = null
      let admissionSettlement: Promise<void> | null = null
      const asError = (error: unknown, fallback: string): Error =>
        error instanceof Error ? error : new Error(fallback)
      const cleanup = () => {
        unlisten?.()
        unlisten = null
      }
      void completion.then(cleanup, cleanup)
      const rejectBeforeAdmission = (error: Error) => {
        if (terminalSeen) return
        terminalSeen = true
        rejectAdmission(error)
        rejectCompletion(error)
      }
      const settleAfterAdmission = (settle: () => void) => {
        if (terminalSeen) return
        terminalSeen = true
        // The durable callback itself may reject. In either case completion remains ordered after
        // the admission settlement rather than racing a failed/cancelled broker terminal ahead.
        void admissionSettlement!
          .then(settle)
          .catch((error: unknown) =>
            rejectCompletion(asError(error, "Codex safe-profile admission failed"))
          )
      }

      void (async () => {
        try {
          const ensureNotCancelled = () => {
            if (request.isCancelled?.()) {
              throw new Error("Codex safe-profile start was cancelled before broker admission")
            }
          }
          ensureNotCancelled()
          const parsedRequest = z
            .object({
              runId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9_-]+$/),
              prKey: z
                .string()
                .min(1)
                .max(256)
                .regex(/^[A-Za-z0-9._/#-]+$/),
              prompt: z
                .string()
                .min(1)
                .max(512 * 1024),
              operation: z.enum(["review", "chat"]),
              model: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9._-]+$/)
                .nullable(),
              provenanceReceiptId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9_-]+$/),
              observedProvenance: observedCodexSafeProfileProvenanceSchema,
            })
            .parse(request)
          const fixedTerminalSchema =
            parsedRequest.operation === "review"
              ? codexSafeProfileReviewTerminalSchema
              : codexSafeProfileChatTerminalSchema
          const deps = await depsPromise

          unlisten = await deps.listen("codex-safe-profile-event", (event) => {
            const parsedEvent = codexSafeProfileEventSchema.safeParse(event.payload)
            if (
              !parsedEvent.success ||
              parsedEvent.data.runId !== parsedRequest.runId ||
              terminalSeen
            ) {
              return
            }

            if (parsedEvent.data.type === "admitted") {
              if (admitted !== null) return
              if (
                !hasExactProvenance(parsedEvent.data.provenance, parsedRequest.observedProvenance)
              ) {
                rejectBeforeAdmission(new CodexSafeProfileProvenanceMismatchError("admission"))
                return
              }
              admitted = {
                runId: parsedEvent.data.runId,
                provenance: parsedEvent.data.provenance,
              }
              // Resolve admission only after the lifecycle callback's durable storage transaction.
              admissionSettlement = Promise.resolve()
                .then(() => onAdmission?.(admitted!))
                .then(() => resolveAdmission(admitted!))
                .catch((error: unknown) => {
                  const admissionError = asError(
                    error,
                    "Codex safe-profile admission acknowledgement failed"
                  )
                  rejectAdmission(admissionError)
                  throw admissionError
                })
              void admissionSettlement.catch(() => undefined)
            }
            if (
              (parsedEvent.data.type === "completed" || parsedEvent.data.type === "failed") &&
              admitted !== null &&
              !hasExactProvenance(parsedEvent.data.provenance, parsedRequest.observedProvenance)
            ) {
              terminalSeen = true
              rejectCompletion(new CodexSafeProfileProvenanceMismatchError("terminal"))
              return
            }
            if (
              parsedEvent.data.type === "started" &&
              parsedEvent.data.provenance !== undefined &&
              parsedEvent.data.provenance !== null &&
              !hasExactProvenance(parsedEvent.data.provenance, parsedRequest.observedProvenance)
            ) {
              terminalSeen = true
              rejectCompletion(new CodexSafeProfileProvenanceMismatchError("terminal"))
              return
            }
            void onEvent?.(parsedEvent.data)

            if (parsedEvent.data.type === "completed") {
              if (admitted === null || admissionSettlement === null) {
                rejectBeforeAdmission(
                  new Error("Codex safe-profile completed before broker admission")
                )
                return
              }
              const { result } = parsedEvent.data
              settleAfterAdmission(() => {
                const fixedTerminal = fixedTerminalSchema.parse(result)
                resolveCompletion(terminalSchema.parse(fixedTerminal))
              })
            }
            if (parsedEvent.data.type === "failed") {
              const terminalError = new Error(
                `Codex safe-profile run failed: ${parsedEvent.data.code}`
              )
              if (admitted === null || admissionSettlement === null) {
                rejectBeforeAdmission(terminalError)
                return
              }
              settleAfterAdmission(() => rejectCompletion(terminalError))
            }
          })
          // Register the event listener before admission, then recheck the latched generation. A
          // cancellation during async listener setup must never reach the typed Rust start command.
          ensureNotCancelled()
          const response = codexSafeProfileStartResponseSchema.parse(
            await deps.invoke("codex_safe_profile_start", {
              request: {
                runId: parsedRequest.runId,
                prKey: parsedRequest.prKey,
                operation: parsedRequest.operation,
                prompt: parsedRequest.prompt,
                model: parsedRequest.model,
                provenanceReceiptId: parsedRequest.provenanceReceiptId,
              },
            })
          )
          if (response.runId !== parsedRequest.runId) {
            throw new Error("Codex safe-profile broker returned a mismatched run ID")
          }
        } catch (error) {
          rejectBeforeAdmission(asError(error, "Codex safe-profile start failed"))
        }
      })()

      return { admission, completion }
    },

    async cancel(runId: string): Promise<void> {
      const parsedRunId = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/)
        .parse(runId)
      const deps = await depsPromise
      await deps.invoke("codex_safe_profile_cancel", { request: { runId: parsedRunId } })
    },
  }
}
