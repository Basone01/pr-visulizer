import type {
  AiReviewRun,
  AiReviewTarget,
  FindingDisposition,
  SelectedJiraCriterion,
} from "@pr-visulizer/shared"
import {
  aiReviewEventSchema,
  aiReviewRunSchema,
  findingDispositionSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

import {
  type ReviewOutputTerminalValidation,
  type RevisionPinnedReviewPatches,
  validateReviewRunOutput,
} from "@/utils/aiReview/findingValidation"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import { deleteRunWithAssociatedJiraSnapshots } from "./jiraSnapshotStorage"
import { serializeStorageMutation } from "./storageMutationQueue"

const RUN_IDS_KEY = "ai-review:run-ids"
const PROVIDER_OWNED_DATA_MESSAGE =
  "Provider-owned sessions, logs, caches, and remote data are outside PR Visualizer storage and require provider-specific cleanup guidance."

const persistedDiagnosticsSchema = z
  .object({
    runId: z.string().min(1),
    sanitizedEvents: z.array(aiReviewEventSchema),
    rawModelOutputPermitted: z.boolean(),
    rawModelOutput: z.string().min(1).nullable(),
  })
  .superRefine((diagnostics, context) => {
    if (!diagnostics.rawModelOutputPermitted && diagnostics.rawModelOutput !== null) {
      context.addIssue({
        code: "custom",
        message: "Raw model output may only be stored when explicitly permitted",
        path: ["rawModelOutput"],
      })
    }
  })

export type PersistedAiReviewDiagnostics = z.infer<typeof persistedDiagnosticsSchema>

export type AiReviewDeletionResult = {
  appOwnedDataDeleted: boolean
  providerOwnedData: {
    status: "not-controlled"
    message: string
  }
}

export type AiReviewTerminalResult = {
  run: AiReviewRun
  validation: ReviewOutputTerminalValidation
}

// The UI owns generation invalidation while this store owns serialization. Rechecking the guard
// inside the serialized mutation prevents a delayed terminal or diagnostic from committing after
// consent/target/provenance invalidation.
export type AiReviewStorageGenerationGuard = () => boolean

function requireCurrentGeneration(guard: AiReviewStorageGenerationGuard | undefined): void {
  if (guard && !guard()) throw new Error("AI review storage mutation is stale for this generation")
}

function runKey(runId: string): string {
  return `ai-review:run:${encodeURIComponent(runId)}`
}

function dispositionIdsKey(runId: string): string {
  return `ai-review:run:${encodeURIComponent(runId)}:disposition-ids`
}

function dispositionKey(runId: string, findingId: string): string {
  return `ai-review:run:${encodeURIComponent(runId)}:disposition:${encodeURIComponent(findingId)}`
}

function diagnosticsKey(runId: string): string {
  return `ai-review:run:${encodeURIComponent(runId)}:diagnostics`
}

function sameRunIdentity(existing: AiReviewRun, next: AiReviewRun): boolean {
  return (
    existing.id === next.id &&
    JSON.stringify(existing.target) === JSON.stringify(next.target) &&
    existing.baseSha === next.baseSha &&
    existing.headSha === next.headSha &&
    existing.inputFingerprint === next.inputFingerprint &&
    existing.contextSecurityFingerprint === next.contextSecurityFingerprint &&
    existing.provider === next.provider &&
    existing.selectedModel === next.selectedModel &&
    existing.cliVersion === next.cliVersion &&
    existing.promptVersion === next.promptVersion &&
    existing.profile === next.profile &&
    existing.createdAt === next.createdAt
  )
}

async function loadValidated<T>(
  store: KeyValueStore,
  key: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const raw = await store.get(key)
  if (raw === null) return null

  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function loadRequiredRun(store: KeyValueStore, runId: string): Promise<AiReviewRun> {
  const raw = await store.get(runKey(runId))
  if (raw === null) throw new Error(`AI review run ${runId} does not exist`)

  try {
    return aiReviewRunSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error(`AI review run ${runId} is not schema-valid storage data`)
  }
}

async function loadRunIds(store: KeyValueStore): Promise<string[]> {
  return (await loadValidated(store, RUN_IDS_KEY, z.array(z.string().min(1)))) ?? []
}

async function saveRunIds(store: KeyValueStore, runIds: string[]): Promise<void> {
  await store.set(RUN_IDS_KEY, JSON.stringify(runIds))
}

async function loadDispositionIds(store: KeyValueStore, runId: string): Promise<string[]> {
  return (await loadValidated(store, dispositionIdsKey(runId), z.array(z.string().min(1)))) ?? []
}

async function saveDispositionIds(
  store: KeyValueStore,
  runId: string,
  findingIds: string[]
): Promise<void> {
  await store.set(dispositionIdsKey(runId), JSON.stringify(findingIds))
}

// What one stored run key holds. `unreadable` covers a present but malformed or schema-invalid
// record, which must never be mistaken for an absent one.
export type AiReviewRunRecordRead =
  { state: "missing" } | { state: "unreadable" } | { state: "stored"; run: AiReviewRun }

export function createAiReviewRunStorage(store: KeyValueStore) {
  const mutate = <T>(mutation: () => Promise<T>): Promise<T> =>
    serializeStorageMutation(store, mutation)
  const loadRun = (runId: string): Promise<AiReviewRun | null> =>
    loadValidated(store, runKey(runId), aiReviewRunSchema)

  const createRun = (
    run: AiReviewRun,
    generationGuard?: AiReviewStorageGenerationGuard
  ): Promise<AiReviewRun> =>
    mutate(async () => {
      requireCurrentGeneration(generationGuard)
      const parsedRun = aiReviewRunSchema.parse(run)
      if (parsedRun.status !== "running") {
        throw new Error("AI review runs must begin in the running state")
      }
      if ((await store.get(runKey(parsedRun.id))) !== null) {
        throw new Error(`AI review run ${parsedRun.id} already exists`)
      }

      requireCurrentGeneration(generationGuard)
      await store.set(runKey(parsedRun.id), JSON.stringify(parsedRun))
      const runIds = await loadRunIds(store)
      if (!runIds.includes(parsedRun.id)) await saveRunIds(store, [...runIds, parsedRun.id])

      return parsedRun
    })

  const transitionTerminalRun = async (
    terminalRun: AiReviewRun,
    generationGuard?: AiReviewStorageGenerationGuard
  ): Promise<AiReviewRun> => {
    requireCurrentGeneration(generationGuard)
    const parsedRun = aiReviewRunSchema.parse(terminalRun)
    if (parsedRun.status === "running") {
      throw new Error("AI review terminal transitions require a terminal status")
    }

    const existing = await loadRequiredRun(store, parsedRun.id)
    requireCurrentGeneration(generationGuard)
    if (existing.status !== "running") {
      throw new Error(`AI review run ${parsedRun.id} is immutable after completion`)
    }
    if (!sameRunIdentity(existing, parsedRun)) {
      throw new Error(`AI review run ${parsedRun.id} cannot change immutable identity fields`)
    }

    requireCurrentGeneration(generationGuard)
    await store.set(runKey(parsedRun.id), JSON.stringify(parsedRun))
    return parsedRun
  }

  return {
    loadRun,

    // Startup recovery has to tell "nothing was ever written for this ID" apart from "a record
    // exists but cannot be read", because only the first is safe to release Rust evidence for.
    // `loadRun` collapses both into null, so this reports the three states separately.
    async readRunRecord(runId: string): Promise<AiReviewRunRecordRead> {
      const raw = await store.get(runKey(runId))
      if (raw === null) return { state: "missing" }

      try {
        const parsed = aiReviewRunSchema.safeParse(JSON.parse(raw))
        return parsed.success ? { state: "stored", run: parsed.data } : { state: "unreadable" }
      } catch {
        return { state: "unreadable" }
      }
    },

    async listRuns(target?: AiReviewTarget): Promise<AiReviewRun[]> {
      const runIds = await loadRunIds(store)
      const runs = await Promise.all(runIds.map(loadRun))
      const validRuns = runs.filter((run): run is AiReviewRun => run !== null)

      if (!target) return validRuns

      return validRuns.filter(
        (run) =>
          run.target.owner === target.owner &&
          run.target.repo === target.repo &&
          run.target.number === target.number
      )
    },

    createRun,

    finalizeRun(
      runId: string,
      output: unknown,
      recordedPatches: RevisionPinnedReviewPatches,
      completedAt: string,
      selectedJiraCriteria: readonly SelectedJiraCriterion[] = [],
      generationGuard?: AiReviewStorageGenerationGuard
    ): Promise<AiReviewTerminalResult> {
      return mutate(async () => {
        requireCurrentGeneration(generationGuard)
        const runningRun = await loadRequiredRun(store, runId)
        if (runningRun.status !== "running") {
          throw new Error(`AI review run ${runId} is already terminal`)
        }
        if (
          recordedPatches.baseSha !== runningRun.baseSha ||
          recordedPatches.headSha !== runningRun.headSha
        ) {
          throw new Error(`AI review run ${runId} patches do not match its immutable revision`)
        }

        const validation = validateReviewRunOutput(
          output,
          recordedPatches.patches,
          selectedJiraCriteria
        )
        const terminalRun: AiReviewRun =
          validation.status === "completed"
            ? {
                ...runningRun,
                ...validation.output,
                status: "completed",
                completedAt,
              }
            : {
                ...runningRun,
                status: "invalid",
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
                completedAt,
              }

        requireCurrentGeneration(generationGuard)
        return { run: await transitionTerminalRun(terminalRun, generationGuard), validation }
      })
    },

    terminateRun(
      runId: string,
      status: "cancelled" | "interrupted" | "failed",
      completedAt: string,
      generationGuard?: AiReviewStorageGenerationGuard
    ): Promise<AiReviewRun> {
      return mutate(async () => {
        requireCurrentGeneration(generationGuard)
        const runningRun = await loadRequiredRun(store, runId)
        requireCurrentGeneration(generationGuard)
        return transitionTerminalRun(
          {
            ...runningRun,
            status,
            completedAt,
          },
          generationGuard
        )
      })
    },

    // Desktop startup owns every record in this local store. Only records still in the sole
    // mutable state may have been abandoned by a prior app exit; malformed, missing, and already
    // terminal records remain untouched rather than being repaired or rewritten during recovery.
    recoverInterruptedRuns(
      completedAt: string,
      safelyRecoveredCodexRunIds: readonly string[] = []
    ): Promise<AiReviewRun[]> {
      return mutate(async () => {
        const interrupted: AiReviewRun[] = []
        const safelyRecoveredCodexRunIdSet = new Set(safelyRecoveredCodexRunIds)
        for (const runId of await loadRunIds(store)) {
          const run = await loadRun(runId)
          if (run?.status !== "running") continue
          // A persisted Codex process can outlive the app. Rust supplies an ID only after its
          // marker-owned PID/start record proved dead or the exact live process was reaped; an
          // absent, reused, or unobservable PID therefore stays running rather than lying about
          // completion while its state remains intentionally preserved.
          if (run.provider === "codex" && !safelyRecoveredCodexRunIdSet.has(run.id)) continue
          // The returned runs are the durably persisted ones, which is what desktop startup
          // acknowledges to Rust. A record that cannot be written stays running, keeps its Rust
          // recovery evidence, and is recovered on a later startup instead of aborting the sweep.
          try {
            interrupted.push(
              await transitionTerminalRun({
                ...run,
                status: "interrupted",
                completedAt,
              })
            )
          } catch {
            continue
          }
        }
        return interrupted
      })
    },

    async loadDispositions(runId: string): Promise<FindingDisposition[]> {
      const findingIds = await loadDispositionIds(store, runId)
      const dispositions = await Promise.all(
        findingIds.map((findingId) =>
          loadValidated(store, dispositionKey(runId, findingId), findingDispositionSchema)
        )
      )

      return dispositions.filter(
        (disposition): disposition is FindingDisposition => disposition !== null
      )
    },

    saveDisposition(
      disposition: FindingDisposition,
      generationGuard?: AiReviewStorageGenerationGuard
    ): Promise<FindingDisposition> {
      return mutate(async () => {
        requireCurrentGeneration(generationGuard)
        const parsedDisposition = findingDispositionSchema.parse(disposition)
        const run = await loadRequiredRun(store, parsedDisposition.runId)
        if (!run.findings.some((finding) => finding.id === parsedDisposition.findingId)) {
          throw new Error(
            `Finding ${parsedDisposition.findingId} does not belong to its AI review run`
          )
        }

        requireCurrentGeneration(generationGuard)
        await store.set(
          dispositionKey(parsedDisposition.runId, parsedDisposition.findingId),
          JSON.stringify(parsedDisposition)
        )
        const findingIds = await loadDispositionIds(store, parsedDisposition.runId)
        if (!findingIds.includes(parsedDisposition.findingId)) {
          await saveDispositionIds(store, parsedDisposition.runId, [
            ...findingIds,
            parsedDisposition.findingId,
          ])
        }

        return parsedDisposition
      })
    },

    async loadDiagnostics(runId: string): Promise<PersistedAiReviewDiagnostics | null> {
      return loadValidated(store, diagnosticsKey(runId), persistedDiagnosticsSchema)
    },

    saveDiagnostics(
      diagnostics: PersistedAiReviewDiagnostics,
      generationGuard?: AiReviewStorageGenerationGuard
    ): Promise<PersistedAiReviewDiagnostics> {
      return mutate(async () => {
        requireCurrentGeneration(generationGuard)
        const parsedDiagnostics = persistedDiagnosticsSchema.parse(diagnostics)
        await loadRequiredRun(store, parsedDiagnostics.runId)
        requireCurrentGeneration(generationGuard)
        await store.set(diagnosticsKey(parsedDiagnostics.runId), JSON.stringify(parsedDiagnostics))
        return parsedDiagnostics
      })
    },

    deleteRun(runId: string): Promise<AiReviewDeletionResult> {
      return deleteRunWithAssociatedJiraSnapshots(store, runId, async () => {
        const findingIds = await loadDispositionIds(store, runId)
        await Promise.all([
          store.delete(runKey(runId)),
          store.delete(dispositionIdsKey(runId)),
          store.delete(diagnosticsKey(runId)),
          ...findingIds.map((findingId) => store.delete(dispositionKey(runId, findingId))),
        ])
        await saveRunIds(
          store,
          (await loadRunIds(store)).filter((storedRunId) => storedRunId !== runId)
        )

        return {
          appOwnedDataDeleted: true,
          providerOwnedData: {
            status: "not-controlled",
            message: PROVIDER_OWNED_DATA_MESSAGE,
          },
        }
      })
    },
  }
}

export type AiReviewRunStorage = ReturnType<typeof createAiReviewRunStorage>
