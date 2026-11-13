import { describe, expect, it } from "vitest"

import {
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  TERMINAL_PROVIDERS,
  TERMINAL_PROVIDER_ORDER,
  describePanelSettings,
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
    [
      "names_the_provider_model_and_surface",
      settingsWith("claude", "haiku"),
      "Claude · Haiku · Chat",
    ],
    [
      "says_cli_default_when_no_model_is_set",
      settingsWith("claude", null),
      "Claude · CLI default · Chat",
    ],
    [
      "shows_a_custom_model_id_as_written",
      settingsWith("claude", "my-model-7"),
      "Claude · my-model-7 · Chat",
    ],
    ["asks_for_a_provider_before_one_is_chosen", settingsWith(null, "haiku"), "Choose a provider"],
  ])("%s", (_promise, settings, expected) => {
    // Arrange
    const surface = "chat"

    // Act
    const summary = describePanelSettings(settings, surface)

    // Assert
    expect(summary).toBe(expected)
  })
})
