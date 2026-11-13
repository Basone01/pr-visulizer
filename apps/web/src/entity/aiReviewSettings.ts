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
  { id: "gpt-6-astra", name: "GPT-6 Astra", label: "GPT-6 Astra — frontier" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", label: "GPT-5.6 Sol — workhorse" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", label: "GPT-5.6 Terra — balanced" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", label: "GPT-5.6 Luna — fast (default)" },
  { id: "gpt-5.5", name: "GPT-5.5", label: "GPT-5.5 — legacy" },
] as const

// Aliases resolve to the newest model of each family, so the list never pins a version.
// Verified from `claude --help` (2.1.289): "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')".
export const CLAUDE_MODEL_SUGGESTIONS = [
  { id: "fable", name: "Fable", label: "Fable — frontier" },
  { id: "opus", name: "Opus", label: "Opus — balanced" },
  { id: "sonnet", name: "Sonnet", label: "Sonnet — fast" },
  { id: "haiku", name: "Haiku", label: "Haiku — fastest (default)" },
] as const

// name is the short form the collapsed settings row shows, label the full one in the picker.
export type ModelSuggestion = { id: string; name: string; label: string }

// How the AI panel talks to the agent: the CLI in a terminal, or a chat driving it headless.
// It is a fact of the provider, never a saved preference.
export type AiPanelSurface = "terminal" | "chat"

export type TerminalProviderDescriptor = {
  label: string
  modelSuggestions: ReadonlyArray<ModelSuggestion>
  // Preselected until the reviewer picks another model, so a first run is quick.
  fastestModelId: string
  surface: AiPanelSurface
}

// The AI panel terminal reads its labels and model choices from here, so adding a provider
// is a data change, not a UI change.
export const TERMINAL_PROVIDERS: Record<SelectableAiProviderId, TerminalProviderDescriptor> = {
  codex: {
    label: "Codex",
    modelSuggestions: CODEX_MODEL_SUGGESTIONS,
    fastestModelId: DEFAULT_CODEX_MODEL_ID,
    surface: "terminal",
  },
  claude: {
    label: "Claude",
    modelSuggestions: CLAUDE_MODEL_SUGGESTIONS,
    fastestModelId: "haiku",
    surface: "chat",
  },
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
  // 0.7.7 also stored a panelSurface choice. The object schema drops unknown keys,
  // so those settings still load and the key is gone after the next save.
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

export function panelSurfaceFor(provider: SelectableAiProviderId): AiPanelSurface {
  return TERMINAL_PROVIDERS[provider].surface
}

export function offersChat(provider: SelectableAiProviderId): boolean {
  return panelSurfaceFor(provider) === "chat"
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

export const NO_PROVIDER_SUMMARY = "Choose a provider"
export const CLI_DEFAULT_MODEL_NAME = "CLI default"

// The one-line summary of the AI panel settings, such as "Claude · Haiku". It is read
// from the same descriptors the controls use.
export function describePanelSettings(settings: AiReviewSettings): string {
  const provider = settings.terminalProvider
  if (provider === null) return NO_PROVIDER_SUMMARY

  const modelName = modelDisplayName(provider, settings.providers[provider].selectedModel)
  return `${TERMINAL_PROVIDERS[provider].label} · ${modelName}`
}

// The short name the app uses for a model choice: "Haiku", "CLI default", or a custom id as written.
export function modelDisplayName(provider: SelectableAiProviderId, modelId: string | null): string {
  if (modelId === null) return CLI_DEFAULT_MODEL_NAME

  const suggestion = TERMINAL_PROVIDERS[provider].modelSuggestions.find(
    (model) => model.id === modelId
  )
  return suggestion?.name ?? modelId
}

// The CLI reports the resolved model ("claude-haiku-5-5"), the app names its aliases ("haiku").
// Null when the resolved id belongs to none of this provider's suggestions.
export function modelNameForResolvedId(
  provider: SelectableAiProviderId,
  resolvedModelId: string
): string | null {
  const suggestion = TERMINAL_PROVIDERS[provider].modelSuggestions.find((model) =>
    isResolvedModel(provider, resolvedModelId, model.id)
  )
  return suggestion?.name ?? null
}

// Whether the CLI's resolved id ("claude-haiku-5-5") is the app's model choice ("haiku").
export function isResolvedModel(
  provider: SelectableAiProviderId,
  resolvedModelId: string,
  modelId: string
): boolean {
  return resolvedModelId === modelId || resolvedModelId.startsWith(`${provider}-${modelId}-`)
}
