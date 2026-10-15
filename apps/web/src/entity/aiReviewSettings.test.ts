import { describe, expect, it } from "vitest"

import { TERMINAL_PROVIDERS, TERMINAL_PROVIDER_ORDER } from "./aiReviewSettings"

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
