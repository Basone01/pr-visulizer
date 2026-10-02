import type { ReviewProfile } from "@pr-visulizer/shared"
import { reviewProfileSchema } from "@pr-visulizer/shared"
import { z } from "zod"

// The deterministic fake adapter is test-only, so it cannot become a saved user preference.
export const selectableAiProviderIdSchema = z.enum(["claude", "codex"])
export type SelectableAiProviderId = z.infer<typeof selectableAiProviderIdSchema>

export const DEFAULT_CODEX_MODEL_ID = "gpt-5.6-luna"

// Advisory choices verified from the local Codex 0.153.4 cache. They are suggestions, not an
// allowlist: CLI default and any custom model ID remain available.
export const CODEX_MODEL_SUGGESTIONS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra — frontier" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol — workhorse" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra — balanced" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna — fast (default)" },
  { id: "gpt-5.5", label: "GPT-5.5 — legacy" },
] as const

// Codex safe profile has one bounded prompt-only pass. Review profiles remain part of the
// immutable input identity, but they never grant delegation, chunking, or synthesis behavior.
export const CODEX_SAFE_PROFILE_REVIEW_DISCLOSURE =
  "Prompt-only single-pass review. It does not delegate work, split context into chunks, or synthesize multiple passes."

const aiProviderModelSettingsSchema = z.object({
  // Null means use the CLI's own default model. A non-null value is a user-entered custom model
  // ID and remains visible even before a successful run confirms it.
  selectedModel: z.string().min(1).nullable(),
  successfulModelIds: z.array(z.string().min(1)),
})
export type AiProviderModelSettings = z.infer<typeof aiProviderModelSettingsSchema>

export const aiReviewSettingsSchema = z.object({
  // A reviewer must choose a provider before first use; no hidden product default or fallback
  // can send repository content to a different provider.
  defaultProvider: selectableAiProviderIdSchema.nullable(),
  defaultProfile: reviewProfileSchema,
  providers: z.object({
    claude: aiProviderModelSettingsSchema,
    codex: aiProviderModelSettingsSchema,
  }),
  // Distinguishes legacy null (the old implicit default) from a reviewer explicitly selecting
  // CLI default after the Luna product default was introduced.
  codexModelDefaultApplied: z.boolean().default(false),
})
export type AiReviewSettings = z.infer<typeof aiReviewSettingsSchema>

export const DEFAULT_AI_REVIEW_SETTINGS: AiReviewSettings = {
  defaultProvider: null,
  defaultProfile: "balanced",
  providers: {
    claude: { selectedModel: null, successfulModelIds: [] },
    codex: { selectedModel: DEFAULT_CODEX_MODEL_ID, successfulModelIds: [] },
  },
  codexModelDefaultApplied: true,
}

// Explicit provider selection wins over a saved preference. This function intentionally never
// considers provider availability or another provider: retrying with a different provider needs
// an explicit reviewer action.
export function resolveAiReviewProvider(
  settings: AiReviewSettings,
  requestedProvider: SelectableAiProviderId | null
): SelectableAiProviderId {
  const parsedSettings = aiReviewSettingsSchema.parse(settings)
  const provider = requestedProvider ?? parsedSettings.defaultProvider
  if (provider === null) throw new Error("Select an AI provider before starting a review")

  return provider
}

// CLI default is always available; retain a current custom ID plus successful IDs without making
// either an authoritative provider catalog.
export function getSelectableModelIds(
  settings: AiReviewSettings,
  provider: SelectableAiProviderId
): Array<string | null> {
  const parsedSettings = aiReviewSettingsSchema.parse(settings)
  const providerSettings = parsedSettings.providers[provider]

  return [
    null,
    ...new Set(
      [providerSettings.selectedModel, ...providerSettings.successfulModelIds].filter(
        (modelId): modelId is string => modelId !== null
      )
    ),
  ]
}
