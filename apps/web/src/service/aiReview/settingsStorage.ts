import type { ReviewProfile } from "@pr-visulizer/shared"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  type AiPanelSurface,
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  type SelectableAiProviderId,
  TERMINAL_PROVIDERS,
  aiReviewSettingsSchema,
} from "@/entity/aiReviewSettings"

import { serializeStorageMutation } from "./storageMutationQueue"

const AI_REVIEW_SETTINGS_KEY = "ai-review:settings"

// The stored flag that records each provider's one-time fastest-model migration.
// Key names are persisted, so they never change.
const MODEL_DEFAULT_APPLIED_FLAG = {
  codex: "codexModelDefaultApplied",
  claude: "claudeModelDefaultApplied",
} as const satisfies Record<SelectableAiProviderId, keyof AiReviewSettings>

function cloneDefaultSettings(): AiReviewSettings {
  return structuredClone(DEFAULT_AI_REVIEW_SETTINGS)
}

async function saveAiReviewSettings(
  store: KeyValueStore,
  settings: AiReviewSettings
): Promise<AiReviewSettings> {
  const parsedSettings = aiReviewSettingsSchema.parse(settings)
  await store.set(AI_REVIEW_SETTINGS_KEY, JSON.stringify(parsedSettings))
  return parsedSettings
}

export async function loadAiReviewSettings(store: KeyValueStore): Promise<AiReviewSettings> {
  const raw = await store.get(AI_REVIEW_SETTINGS_KEY)
  if (raw === null) return cloneDefaultSettings()

  try {
    const parsed = aiReviewSettingsSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return cloneDefaultSettings()

    const withCodexDefault = applyFastestModelDefaultOnce(parsed.data, "codex")
    return applyFastestModelDefaultOnce(withCodexDefault, "claude")
  } catch {
    return cloneDefaultSettings()
  }
}

// Settings saved before a provider had a default store null, the old implicit CLI default.
// Replace that null once. After the flag is set, null means the reviewer chose CLI default.
function applyFastestModelDefaultOnce(
  settings: AiReviewSettings,
  provider: SelectableAiProviderId
): AiReviewSettings {
  const flag = MODEL_DEFAULT_APPLIED_FLAG[provider]
  if (settings[flag]) return settings

  const providerSettings = settings.providers[provider]
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [provider]: {
        ...providerSettings,
        selectedModel:
          providerSettings.selectedModel ?? TERMINAL_PROVIDERS[provider].fastestModelId,
      },
    },
    [flag]: true,
  }
}

export function createAiReviewSettingsStorage(store: KeyValueStore) {
  const mutate = <T>(mutation: () => Promise<T>): Promise<T> =>
    serializeStorageMutation(store, mutation)

  return {
    load: (): Promise<AiReviewSettings> => loadAiReviewSettings(store),

    saveDefaultProvider(provider: SelectableAiProviderId): Promise<AiReviewSettings> {
      return mutate(async () => {
        const settings = await loadAiReviewSettings(store)
        return saveAiReviewSettings(store, { ...settings, defaultProvider: provider })
      })
    },

    saveDefaultProfile(profile: ReviewProfile): Promise<AiReviewSettings> {
      return mutate(async () => {
        const settings = await loadAiReviewSettings(store)
        return saveAiReviewSettings(store, { ...settings, defaultProfile: profile })
      })
    },

    saveTerminalProvider(provider: SelectableAiProviderId): Promise<AiReviewSettings> {
      return mutate(async () => {
        const settings = await loadAiReviewSettings(store)
        return saveAiReviewSettings(store, { ...settings, terminalProvider: provider })
      })
    },

    savePanelSurface(panelSurface: AiPanelSurface): Promise<AiReviewSettings> {
      return mutate(async () => {
        const settings = await loadAiReviewSettings(store)
        return saveAiReviewSettings(store, { ...settings, panelSurface })
      })
    },

    saveSelectedModel(
      provider: SelectableAiProviderId,
      selectedModel: string | null
    ): Promise<AiReviewSettings> {
      return mutate(async () => {
        const settings = await loadAiReviewSettings(store)
        return saveAiReviewSettings(store, {
          ...settings,
          providers: {
            ...settings.providers,
            [provider]: { ...settings.providers[provider], selectedModel },
          },
        })
      })
    },

    rememberSuccessfulModel(
      provider: SelectableAiProviderId,
      modelId: string
    ): Promise<AiReviewSettings> {
      return mutate(async () => {
        const settings = await loadAiReviewSettings(store)
        const providerSettings = settings.providers[provider]
        const successfulModelIds = providerSettings.successfulModelIds.includes(modelId)
          ? providerSettings.successfulModelIds
          : [...providerSettings.successfulModelIds, modelId]

        return saveAiReviewSettings(store, {
          ...settings,
          providers: {
            ...settings.providers,
            [provider]: { ...providerSettings, successfulModelIds },
          },
        })
      })
    },
  }
}

export type AiReviewSettingsStorage = ReturnType<typeof createAiReviewSettingsStorage>
