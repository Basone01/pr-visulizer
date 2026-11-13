import { describe, expect, it } from "vitest"

import {
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  TERMINAL_PROVIDERS,
  TERMINAL_PROVIDER_ORDER,
  describePanelSettings,
  modelNameForResolvedId,
  panelSurfaceFor,
} from "./aiReviewSettings"

describe("TERMINAL_PROVIDERS", () => {
  it("every_provider_lists_its_fastest_model_among_its_suggestions", () => {
    // Arrange
    const providers = TERMINAL_PROVIDER_ORDER

    // Act
    const providersMissingTheirFastestModel = providers.filter((provider) => {
      const { fastestModelId, modelSuggestions } = TERMINAL_PROVIDERS[provider]
      return !modelSuggestions.some((suggestion) => suggestion.id === fastestModelId)
    })

    // Assert
    expect(providersMissingTheirFastestModel).toEqual([])
  })
})

describe("describePanelSettings", () => {
  function settingsWith(
    provider: AiReviewSettings["terminalProvider"],
    claudeModel: string | null
  ): AiReviewSettings {
    return {
      ...DEFAULT_AI_REVIEW_SETTINGS,
      terminalProvider: provider,
      providers: {
        ...DEFAULT_AI_REVIEW_SETTINGS.providers,
        claude: { selectedModel: claudeModel, successfulModelIds: [] },
      },
    }
  }

  it.each([
    ["names_the_provider_and_model", settingsWith("claude", "haiku"), "Claude · Haiku"],
    ["says_cli_default_when_no_model_is_set", settingsWith("claude", null), "Claude · CLI default"],
    [
      "shows_a_custom_model_id_as_written",
      settingsWith("claude", "my-model-7"),
      "Claude · my-model-7",
    ],
    ["asks_for_a_provider_before_one_is_chosen", settingsWith(null, "haiku"), "Choose a provider"],
  ])("%s", (_promise, settings, expected) => {
    // Arrange
    const panelSettings = settings

    // Act
    const summary = describePanelSettings(panelSettings)

    // Assert
    expect(summary).toBe(expected)
  })
})

describe("panelSurfaceFor", () => {
  it.each([
    ["claude_opens_in_chat_with_no_surface_choice", "claude", "chat"],
    ["codex_opens_in_the_terminal_with_no_surface_choice", "codex", "terminal"],
  ] as const)("%s", (_promise, provider, expected) => {
    // Arrange
    const chosenProvider = provider

    // Act
    const surface = panelSurfaceFor(chosenProvider)

    // Assert
    expect(surface).toBe(expected)
  })
})

describe("modelNameForResolvedId", () => {
  it.each([
    ["a_resolved_claude_id_maps_to_the_app_label", "claude-haiku-5-5", "Haiku"],
    ["a_bare_alias_maps_to_the_app_label", "opus", "Opus"],
    ["an_unknown_resolved_id_has_no_label", "claude-mystery-1", null],
    ["a_label_prefix_alone_does_not_match_another_family", "claude-haikuish-1", null],
  ] as const)("%s", (_promise, resolvedModelId, expected) => {
    // Arrange
    const provider = "claude"

    // Act
    const modelName = modelNameForResolvedId(provider, resolvedModelId)

    // Assert
    expect(modelName).toBe(expected)
  })
})
