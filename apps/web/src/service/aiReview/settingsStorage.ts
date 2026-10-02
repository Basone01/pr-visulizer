import type { ReviewProfile } from "@pr-visulizer/shared"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  type SelectableAiProviderId,
  aiReviewSettingsSchema,
} from "@/entity/aiReviewSettings"

import { serializeStorageMutation } from "./storageMutationQueue"

const AI_REVIEW_SETTINGS_KEY = "ai-review:settings"

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
    if (parsed.data.codexModelDefaultApplied) return parsed.data

    return {
      ...parsed.data,
      providers: {
        ...parsed.data.providers,
        codex: {
          ...parsed.data.providers.codex,
          selectedModel:
            parsed.data.providers.codex.selectedModel ??
            DEFAULT_AI_REVIEW_SETTINGS.providers.codex.selectedModel,
        },
      },
      codexModelDefaultApplied: true,
    }
  } catch {
    return cloneDefaultSettings()
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
