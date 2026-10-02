import type {
  AiReviewRun,
  AiReviewTarget,
  FindingDisposition,
  ProviderCapabilities,
} from "@pr-visulizer/shared"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { type CurrentReviewIdentity } from "@/utils/aiReview/promoteFinding"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  type SelectableAiProviderId,
} from "@/entity/aiReviewSettings"

import { createClaudeAiReviewProvider } from "@/service/aiReview/providers/claudeProvider"
import { createCodexAiReviewProvider } from "@/service/aiReview/providers/codexProvider"
import { createAiReviewRunStorage } from "@/service/aiReview/runStorage"
import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"

const PROVIDERS = {
  claude: createClaudeAiReviewProvider,
  codex: createCodexAiReviewProvider,
} as const

export type AiReviewRunCompatibility = "compatible" | "stale" | "context-unknown"

export type AiReviewPanelData = {
  status: "loading" | "ready" | "error"
  error: string | null
  settings: AiReviewSettings
  capabilities: ProviderCapabilities | null
  providerCapabilities: Record<SelectableAiProviderId, ProviderCapabilities | null>
  settingsMutationPending: boolean
  settingsMutationError: string | null
  runs: AiReviewRun[]
  preferredRunId: string | null
  runCompatibilityById: Map<string, AiReviewRunCompatibility>
  diagnosticsByRunId: Map<string, string[]>
  refresh(): Promise<void>
  chooseProvider(provider: SelectableAiProviderId): Promise<void>
  chooseProfile(profile: AiReviewSettings["defaultProfile"]): Promise<void>
  chooseModel(modelId: string | null): Promise<void>
  saveFindingDisposition(disposition: FindingDisposition): Promise<void>
}

function runCompatibility(
  run: AiReviewRun,
  currentReviewIdentity: CurrentReviewIdentity | null
): AiReviewRunCompatibility {
  if (currentReviewIdentity === null) return "context-unknown"

  return run.target.owner === currentReviewIdentity.target.owner &&
    run.target.repo === currentReviewIdentity.target.repo &&
    run.target.number === currentReviewIdentity.target.number &&
    run.baseSha === currentReviewIdentity.baseSha &&
    run.headSha === currentReviewIdentity.headSha &&
    run.inputFingerprint === currentReviewIdentity.inputFingerprint
    ? "compatible"
    : "stale"
}

// This hook is the desktop UI's storage/probe edge. It only reads app-owned JSON records and the
// fail-closed provider capability objects; no panel interaction can invoke a CLI or broker command.
export function useAiReviewPanelData(
  storage: KeyValueStore,
  target: AiReviewTarget,
  currentReviewIdentity: CurrentReviewIdentity | null = null
): AiReviewPanelData {
  const [status, setStatus] = useState<AiReviewPanelData["status"]>("loading")
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AiReviewSettings>(DEFAULT_AI_REVIEW_SETTINGS)
  const [providerCapabilities, setProviderCapabilities] = useState<
    Record<SelectableAiProviderId, ProviderCapabilities | null>
  >({ claude: null, codex: null })
  const [settingsMutationPending, setSettingsMutationPending] = useState(false)
  const [settingsMutationError, setSettingsMutationError] = useState<string | null>(null)
  const [runs, setRuns] = useState<AiReviewRun[]>([])
  const [diagnosticsByRunId, setDiagnosticsByRunId] = useState<Map<string, string[]>>(new Map())
  const operationGenerationRef = useRef(0)
  const capabilities =
    settings.defaultProvider === null ? null : providerCapabilities[settings.defaultProvider]

  // Loading app-owned records and probing provider availability are storage/broker edges. They
  // must not depend on the derived identity below: that identity is recomputed after context
  // assembly and would otherwise re-enter this effect through the panel's loading state.
  const load = useCallback(async () => {
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setStatus("loading")
    setError(null)
    setSettingsMutationPending(false)
    setSettingsMutationError(null)
    try {
      const runStorage = createAiReviewRunStorage(storage)
      const settingsStorage = createAiReviewSettingsStorage(storage)
      const currentTarget = { owner: target.owner, repo: target.repo, number: target.number }
      const [storedSettings, storedRuns] = await Promise.all([
        settingsStorage.load(),
        runStorage.listRuns(currentTarget),
      ])
      const orderedRuns = [...storedRuns].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )
      const diagnostics = await Promise.all(
        orderedRuns.map(async (run) => {
          const entry = await runStorage.loadDiagnostics(run.id)
          return [
            run.id,
            (entry?.sanitizedEvents ?? [])
              .filter((event) => "message" in event)
              .map((event) => event.message),
          ] as const
        })
      )

      const [claudeCapabilities, codexCapabilities] = await Promise.all([
        PROVIDERS.claude().probe({
          provider: "claude",
          executablePath: null,
          selectedModel: storedSettings.providers.claude.selectedModel,
        }),
        PROVIDERS.codex().probe({
          provider: "codex",
          executablePath: null,
          selectedModel: storedSettings.providers.codex.selectedModel,
        }),
      ])
      const nextProviderCapabilities = {
        claude: claudeCapabilities,
        codex: codexCapabilities,
      }
      if (operationGenerationRef.current !== operationGeneration) return

      setSettings(storedSettings)
      setRuns(orderedRuns)
      setDiagnosticsByRunId(new Map(diagnostics))
      setProviderCapabilities(nextProviderCapabilities)
      setStatus("ready")
    } catch (loadError) {
      if (operationGenerationRef.current !== operationGeneration) return

      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setStatus("error")
    }
  }, [storage, target.number, target.owner, target.repo])

  useEffect(() => {
    void load()
  }, [load])

  const runCompatibilityById = useMemo(
    () => new Map(runs.map((run) => [run.id, runCompatibility(run, currentReviewIdentity)])),
    [currentReviewIdentity, runs]
  )
  const preferredRunId = useMemo(
    () => runs.find((run) => runCompatibilityById.get(run.id) === "compatible")?.id ?? null,
    [runCompatibilityById, runs]
  )

  async function chooseProvider(provider: SelectableAiProviderId): Promise<void> {
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setSettingsMutationPending(true)
    setSettingsMutationError(null)
    try {
      const next = await createAiReviewSettingsStorage(storage).saveDefaultProvider(provider)
      const nextCapabilities = await PROVIDERS[provider]().probe({
        provider,
        executablePath: null,
        selectedModel: next.providers[provider].selectedModel,
      })
      if (operationGenerationRef.current !== operationGeneration) return

      setSettings(next)
      setProviderCapabilities((current) => ({ ...current, [provider]: nextCapabilities }))
    } catch (chooseError) {
      if (operationGenerationRef.current !== operationGeneration) return

      setSettingsMutationError(
        chooseError instanceof Error ? chooseError.message : "Could not save the AI provider."
      )
    } finally {
      if (operationGenerationRef.current === operationGeneration) setSettingsMutationPending(false)
    }
  }

  async function chooseProfile(profile: AiReviewSettings["defaultProfile"]): Promise<void> {
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setSettingsMutationPending(true)
    setSettingsMutationError(null)
    try {
      const next = await createAiReviewSettingsStorage(storage).saveDefaultProfile(profile)
      if (operationGenerationRef.current !== operationGeneration) return

      setSettings(next)
    } catch (chooseError) {
      if (operationGenerationRef.current !== operationGeneration) return

      setSettingsMutationError(
        chooseError instanceof Error ? chooseError.message : "Could not save the review profile."
      )
    } finally {
      if (operationGenerationRef.current === operationGeneration) setSettingsMutationPending(false)
    }
  }

  async function chooseModel(modelId: string | null): Promise<void> {
    if (settings.defaultProvider === null) return

    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setSettingsMutationPending(true)
    setSettingsMutationError(null)
    try {
      const next = await createAiReviewSettingsStorage(storage).saveSelectedModel(
        settings.defaultProvider,
        modelId
      )
      if (operationGenerationRef.current !== operationGeneration) return

      setSettings(next)
    } catch (chooseError) {
      if (operationGenerationRef.current !== operationGeneration) return

      setSettingsMutationError(
        chooseError instanceof Error ? chooseError.message : "Could not save the model."
      )
    } finally {
      if (operationGenerationRef.current === operationGeneration) setSettingsMutationPending(false)
    }
  }

  async function saveFindingDisposition(disposition: FindingDisposition): Promise<void> {
    await createAiReviewRunStorage(storage).saveDisposition(disposition)
  }

  return {
    status,
    error,
    settings,
    capabilities,
    providerCapabilities,
    settingsMutationPending,
    settingsMutationError,
    runs,
    preferredRunId,
    runCompatibilityById,
    diagnosticsByRunId,
    refresh: load,
    chooseProvider,
    chooseProfile,
    chooseModel,
    saveFindingDisposition,
  }
}
