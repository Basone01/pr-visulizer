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

// Aliases resolve to the newest model of each family, so the list never pins a version.
// Verified from `claude --help` (2.1.289): "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')".
export const CLAUDE_MODEL_SUGGESTIONS = [
  { id: "fable", label: "Fable — frontier" },
  { id: "opus", label: "Opus — balanced" },
  { id: "sonnet", label: "Sonnet — fast" },
  { id: "haiku", label: "Haiku — fastest (default)" },
] as const

export type ModelSuggestion = { id: string; label: string }

export type TerminalProviderDescriptor = {
  label: string
  modelSuggestions: ReadonlyArray<ModelSuggestion>
  // Preselected until the reviewer picks another model, so a first run is quick.
  fastestModelId: string
}

// The AI panel terminal reads its labels and model choices from here, so adding a provider
// is a data change, not a UI change.
export const TERMINAL_PROVIDERS: Record<SelectableAiProviderId, TerminalProviderDescriptor> = {
  codex: {
    label: "Codex",
    modelSuggestions: CODEX_MODEL_SUGGESTIONS,
    fastestModelId: DEFAULT_CODEX_MODEL_ID,
  },
  claude: { label: "Claude", modelSuggestions: CLAUDE_MODEL_SUGGESTIONS, fastestModelId: "haiku" },
}

// Codex leads because it is the established provider.
export const TERMINAL_PROVIDER_ORDER: ReadonlyArray<SelectableAiProviderId> = ["codex", "claude"]

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
  // Distinguish legacy null (the old implicit default) from a reviewer explicitly selecting
  // CLI default after the fastest-model default was introduced, one flag per provider.
  codexModelDefaultApplied: z.boolean().default(false),
  claudeModelDefaultApplied: z.boolean().default(false),
  // Which CLI the AI panel terminal runs. Null until the reviewer chooses, for the same reason
  // as defaultProvider: no hidden default may send repository content to a provider.
  terminalProvider: selectableAiProviderIdSchema.nullable().default(null),
})
export type AiReviewSettings = z.infer<typeof aiReviewSettingsSchema>

export const DEFAULT_AI_REVIEW_SETTINGS: AiReviewSettings = {
  defaultProvider: null,
  defaultProfile: "balanced",
  providers: {
    claude: { selectedModel: TERMINAL_PROVIDERS.claude.fastestModelId, successfulModelIds: [] },
    codex: { selectedModel: TERMINAL_PROVIDERS.codex.fastestModelId, successfulModelIds: [] },
  },
  codexModelDefaultApplied: true,
  claudeModelDefaultApplied: true,
  terminalProvider: null,
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
