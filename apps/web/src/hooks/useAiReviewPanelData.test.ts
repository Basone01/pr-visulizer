import type { AiReviewRun } from "@pr-visulizer/shared"
import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { CurrentReviewIdentity } from "@/utils/aiReview/promoteFinding"
import { type KeyValueStore, createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { createAiReviewRunStorage } from "@/service/aiReview/runStorage"
import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"

import { useAiReviewPanelData } from "./useAiReviewPanelData"

vi.mock("@/service/aiReview/providers/codexProvider", () => ({
  createCodexAiReviewProvider: () => ({
    probe: async () => ({
      available: true,
      executablePath: null,
      cliVersion: "0.153.4",
      observedProvenance: {
        executableIdentityDigest: "a".repeat(64),
        cliVersion: "0.153.4",
        helpDigest: "b".repeat(64),
        safeProfileRevision: "codex-safe-profile-r2",
        provenanceFingerprint: "c".repeat(64),
      },
      missingCapabilities: [],
      warning: null,
    }),
  }),
}))

const TARGET = { owner: "acme", repo: "webapp", number: 42 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function runningRun(
  id: string,
  createdAt: string,
  inputFingerprint: string,
  headSha = "head-sha"
): AiReviewRun {
  return {
    id,
    target: TARGET,
    baseSha: "base-sha",
    headSha,
    inputFingerprint,
    contextSecurityFingerprint: "context-security-fingerprint",
    provider: "fake",
    selectedModel: null,
    reportedModel: null,
    cliVersion: "fixture-1",
    promptVersion: "ai-review-v1",
    profile: "balanced",
    status: "running",
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
    createdAt,
    completedAt: null,
  }
}

describe("useAiReviewPanelData", () => {
  it("discovers_available_codex_while_preserving_the_saved_claude_choice", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    await storage.set(
      "ai-review:settings",
      JSON.stringify({
        defaultProvider: "claude",
        defaultProfile: "balanced",
        providers: {
          claude: { selectedModel: null, successfulModelIds: [] },
          codex: { selectedModel: null, successfulModelIds: [] },
        },
      })
    )

    // Act
    const hook = renderHook(() => useAiReviewPanelData(storage, TARGET))
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))

    // Assert
    expect(hook.result.current.settings.defaultProvider).toBe("claude")
    expect(hook.result.current.capabilities?.available).toBe(false)
    expect(hook.result.current.providerCapabilities.codex?.available).toBe(true)
  })

  it("contains_provider_save_failure_as_visible_hook_state", async () => {
    // Arrange
    const backing = createMemoryKeyValueStore()
    const storage = {
      get: backing.get,
      delete: backing.delete,
      set: vi.fn(async () => {
        throw new Error("settings disk is read-only")
      }),
    }
    const hook = renderHook(() => useAiReviewPanelData(storage, TARGET))
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))

    // Act
    await act(() => hook.result.current.chooseProvider("codex"))

    // Assert
    expect(hook.result.current.settings.defaultProvider).toBeNull()
    expect(hook.result.current.settingsMutationPending).toBe(false)
    expect(hook.result.current.settingsMutationError).toBe("settings disk is read-only")
  })

  it("slow_previous_target_load_cannot_overwrite_the_current_target", async () => {
    // Arrange
    const oldRead = deferred<string | null>()
    const oldStorage: KeyValueStore = {
      get: vi.fn(() => oldRead.promise),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }
    const currentStorage = createMemoryKeyValueStore()
    await currentStorage.set(
      "ai-review:settings",
      JSON.stringify({
        defaultProvider: "codex",
        defaultProfile: "thorough",
        providers: {
          claude: { selectedModel: null, successfulModelIds: [] },
          codex: { selectedModel: null, successfulModelIds: [] },
        },
      })
    )
    const hook = renderHook(({ storage, target }) => useAiReviewPanelData(storage, target), {
      initialProps: { storage: oldStorage, target: TARGET },
    })

    // Act
    hook.rerender({
      storage: currentStorage,
      target: { owner: "acme", repo: "current", number: 43 },
    })
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))
    oldRead.resolve(null)
    await act(async () => Promise.resolve())

    // Assert
    expect(hook.result.current.settings.defaultProvider).toBe("codex")
    expect(hook.result.current.settings.defaultProfile).toBe("thorough")
  })

  it("newer_settings_mutation_wins_without_losing_the_serialized_write", async () => {
    // Arrange
    const backing = createMemoryKeyValueStore()
    let releaseFirstWrite: (() => void) | null = null
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writeCount = 0
    const storage = {
      get: backing.get,
      delete: backing.delete,
      async set(key: string, value: string) {
        writeCount += 1
        if (writeCount === 1) await firstWrite
        await backing.set(key, value)
      },
    }
    const hook = renderHook(() => useAiReviewPanelData(storage, TARGET))
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))

    // Act
    let quick!: Promise<void>
    let thorough!: Promise<void>
    act(() => {
      quick = hook.result.current.chooseProfile("quick")
      thorough = hook.result.current.chooseProfile("thorough")
    })
    releaseFirstWrite!()
    await act(async () => Promise.all([quick, thorough]))

    // Assert
    expect(hook.result.current.settings.defaultProfile).toBe("thorough")
    expect((await createAiReviewSettingsStorage(backing).load()).defaultProfile).toBe("thorough")
    expect(hook.result.current.settingsMutationPending).toBe(false)
  })

  it("live_review_identity_invalidates_on_revision_model_or_profile_change", async () => {
    // Arrange — each fingerprint represents the complete context built from the corresponding
    // live revisions, selected model, and profile; no launched-run identity is reused.
    const storage = createMemoryKeyValueStore()
    const runStorage = createAiReviewRunStorage(storage)
    const run = runningRun("current", "2026-09-13T12:00:00.000Z", "fingerprint-balanced-default")
    await runStorage.createRun(run)
    const current: CurrentReviewIdentity = {
      target: TARGET,
      baseSha: run.baseSha,
      headSha: run.headSha,
      inputFingerprint: run.inputFingerprint,
    }
    const changedIdentities: CurrentReviewIdentity[] = [
      { ...current, headSha: "new-head-sha", inputFingerprint: "fingerprint-new-revision" },
      { ...current, inputFingerprint: "fingerprint-balanced-selected-model" },
      { ...current, inputFingerprint: "fingerprint-thorough-default" },
    ]

    // Act
    const hook = renderHook(
      ({ identity }: { identity: CurrentReviewIdentity }) =>
        useAiReviewPanelData(storage, TARGET, identity),
      { initialProps: { identity: current } }
    )
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))

    // Assert
    expect(hook.result.current.runCompatibilityById.get(run.id)).toBe("compatible")
    for (const identity of changedIdentities) {
      hook.rerender({ identity })
      await waitFor(() =>
        expect(hook.result.current.runCompatibilityById.get(run.id)).toBe("stale")
      )
    }
  })

  it("prefers_an_exact_current_fingerprint_and_marks_unknown_context_history", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const runStorage = createAiReviewRunStorage(storage)
    const compatibleRun = runningRun("compatible", "2026-09-13T12:00:00.000Z", "input-current")
    const newerStaleRun = runningRun(
      "newer-stale",
      "2026-09-13T13:00:00.000Z",
      "input-stale",
      "new-head-sha"
    )
    const currentReviewIdentity: CurrentReviewIdentity = {
      target: TARGET,
      baseSha: compatibleRun.baseSha,
      headSha: compatibleRun.headSha,
      inputFingerprint: compatibleRun.inputFingerprint,
    }
    await runStorage.createRun(compatibleRun)
    await runStorage.createRun(newerStaleRun)

    // Act
    const current = renderHook(() => useAiReviewPanelData(storage, TARGET, currentReviewIdentity))
    await waitFor(() => expect(current.result.current.status).toBe("ready"))

    // Assert
    expect(current.result.current.preferredRunId).toBe("compatible")
    expect(current.result.current.runCompatibilityById.get("compatible")).toBe("compatible")
    expect(current.result.current.runCompatibilityById.get("newer-stale")).toBe("stale")

    const contextUnknown = renderHook(() => useAiReviewPanelData(storage, TARGET))
    await waitFor(() => expect(contextUnknown.result.current.status).toBe("ready"))
    expect(contextUnknown.result.current.runCompatibilityById.get("compatible")).toBe(
      "context-unknown"
    )
    expect(contextUnknown.result.current.runCompatibilityById.get("newer-stale")).toBe(
      "context-unknown"
    )
  })
})
