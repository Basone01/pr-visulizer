import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import {
  CODEX_SAFE_PROFILE_REVIEW_DISCLOSURE,
  DEFAULT_AI_REVIEW_SETTINGS,
  getSelectableModelIds,
  resolveAiReviewProvider,
} from "@/entity/aiReviewSettings"

import { createAiReviewSettingsStorage } from "./settingsStorage"

describe("AI review settings storage", () => {
  it("starts from balanced settings when stored settings are missing or malformed", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)

    // Act
    const missingSettings = await storage.load()
    await store.set("ai-review:settings", "not JSON")
    const malformedSettings = await storage.load()

    // Assert
    expect(missingSettings).toEqual(DEFAULT_AI_REVIEW_SETTINGS)
    expect(malformedSettings).toEqual(DEFAULT_AI_REVIEW_SETTINGS)
  })

  it("persists an explicit provider, profile, custom model, and only successful model IDs", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const customCodexModel = "o4-reviewer"
    const successfulClaudeModel = "claude-sonnet"

    // Act
    await storage.saveDefaultProvider("codex")
    await storage.saveDefaultProfile("thorough")
    await storage.saveSelectedModel("codex", customCodexModel)
    await storage.rememberSuccessfulModel("claude", successfulClaudeModel)
    await storage.rememberSuccessfulModel("claude", successfulClaudeModel)
    const settings = await storage.load()

    // Assert
    expect(settings).toEqual({
      defaultProvider: "codex",
      defaultProfile: "thorough",
      providers: {
        claude: { selectedModel: "haiku", successfulModelIds: [successfulClaudeModel] },
        codex: { selectedModel: customCodexModel, successfulModelIds: [] },
      },
      codexModelDefaultApplied: true,
      claudeModelDefaultApplied: true,
      terminalProvider: null,
      panelSurface: "terminal",
    })
  })

  it("concurrent_settings_factories_preserve_different_field_updates", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const providerSettingsStorage = createAiReviewSettingsStorage(store)
    const profileSettingsStorage = createAiReviewSettingsStorage(store)
    const modelSettingsStorage = createAiReviewSettingsStorage(store)

    // Act
    await Promise.all([
      providerSettingsStorage.saveDefaultProvider("codex"),
      profileSettingsStorage.saveDefaultProfile("thorough"),
      modelSettingsStorage.saveSelectedModel("claude", "claude-reviewer"),
    ])
    const settings = await createAiReviewSettingsStorage(store).load()

    // Assert
    expect(settings).toEqual({
      defaultProvider: "codex",
      defaultProfile: "thorough",
      providers: {
        claude: { selectedModel: "claude-reviewer", successfulModelIds: [] },
        codex: {
          selectedModel: DEFAULT_AI_REVIEW_SETTINGS.providers.codex.selectedModel,
          successfulModelIds: [],
        },
      },
      codexModelDefaultApplied: true,
      claudeModelDefaultApplied: true,
      terminalProvider: null,
      panelSurface: "terminal",
    })
  })

  it("applies the fast Codex model once to legacy CLI-default settings", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const legacySettings = {
      defaultProvider: "codex",
      defaultProfile: "balanced",
      providers: {
        claude: { selectedModel: null, successfulModelIds: [] },
        codex: { selectedModel: null, successfulModelIds: [] },
      },
    }
    await store.set("ai-review:settings", JSON.stringify(legacySettings))

    // Act
    const settings = await storage.load()

    // Assert
    expect(settings.providers.codex.selectedModel).toBe("gpt-5.6-luna")
    expect(settings.codexModelDefaultApplied).toBe(true)
  })

  it("remembers_the_saved_terminal_provider", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const terminalProvider = "claude"

    // Act
    await storage.saveTerminalProvider(terminalProvider)
    const reloadedSettings = await createAiReviewSettingsStorage(store).load()

    // Assert
    expect(reloadedSettings.terminalProvider).toBe(terminalProvider)
  })

  it("loads_legacy_settings_without_a_terminal_provider_as_unchosen", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const legacySettings = {
      defaultProvider: "codex",
      defaultProfile: "balanced",
      providers: {
        claude: { selectedModel: null, successfulModelIds: [] },
        codex: { selectedModel: "gpt-5.6-sol", successfulModelIds: [] },
      },
      codexModelDefaultApplied: true,
    }
    await store.set("ai-review:settings", JSON.stringify(legacySettings))

    // Act
    const settings = await storage.load()

    // Assert
    expect(settings.terminalProvider).toBeNull()
  })

  it("preserves an explicit CLI default after the one-time migration", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)

    // Act
    await storage.saveSelectedModel("codex", null)
    const reloadedSettings = await storage.load()

    // Assert
    expect(reloadedSettings.providers.codex.selectedModel).toBeNull()
    expect(reloadedSettings.codexModelDefaultApplied).toBe(true)
  })

  it("exposes CLI default, current custom, and prior successful model IDs without a hardcoded catalog", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const currentCustomModel = "o4-reviewer"
    const priorSuccessfulModel = "o3"
    await storage.saveSelectedModel("codex", currentCustomModel)
    await storage.rememberSuccessfulModel("codex", currentCustomModel)
    await storage.rememberSuccessfulModel("codex", priorSuccessfulModel)

    // Act
    const settings = await storage.load()
    const modelIds = getSelectableModelIds(settings, "codex")

    // Assert
    expect(modelIds).toEqual([null, currentCustomModel, priorSuccessfulModel])
  })

  it("uses only the explicit or saved provider and never silently falls back", () => {
    // Arrange
    const settingsWithClaudeDefault = {
      ...DEFAULT_AI_REVIEW_SETTINGS,
      defaultProvider: "claude" as const,
    }
    const settingsWithoutDefault = DEFAULT_AI_REVIEW_SETTINGS

    // Act
    const explicitCodexProvider = resolveAiReviewProvider(settingsWithClaudeDefault, "codex")
    const savedClaudeProvider = resolveAiReviewProvider(settingsWithClaudeDefault, null)
    const missingProvider = () => resolveAiReviewProvider(settingsWithoutDefault, null)

    // Assert
    expect(explicitCodexProvider).toBe("codex")
    expect(savedClaudeProvider).toBe("claude")
    expect(missingProvider).toThrow("Select an AI provider before starting a review")
  })

  it("declares_codex_safe_profile_as_single_pass_without_delegation", () => {
    // Arrange
    const expectedDisclosure =
      "Prompt-only single-pass review. It does not delegate work, split context into chunks, or synthesize multiple passes."

    // Act
    const disclosure = CODEX_SAFE_PROFILE_REVIEW_DISCLOSURE

    // Assert
    expect(disclosure).toBe(expectedDisclosure)
  })

  it("preselects_haiku_for_claude_when_no_model_was_ever_chosen", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)

    // Act
    const settings = await storage.load()

    // Assert
    const expected = "haiku"
    expect(settings.providers.claude.selectedModel).toBe(expected)
  })

  it("migrates_a_legacy_null_claude_model_to_haiku_once", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const legacySettings = {
      defaultProvider: "claude",
      defaultProfile: "balanced",
      providers: {
        claude: { selectedModel: null, successfulModelIds: [] },
        codex: { selectedModel: "gpt-5.6-sol", successfulModelIds: [] },
      },
      codexModelDefaultApplied: true,
    }
    await store.set("ai-review:settings", JSON.stringify(legacySettings))

    // Act
    const settings = await storage.load()

    // Assert
    const expected = { selectedModel: "haiku", claudeModelDefaultApplied: true }
    expect({
      selectedModel: settings.providers.claude.selectedModel,
      claudeModelDefaultApplied: settings.claudeModelDefaultApplied,
    }).toEqual(expected)
  })

  it("keeps_cli_default_for_claude_after_the_reviewer_chose_it", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const cliDefaultModel = null
    await storage.saveSelectedModel("claude", cliDefaultModel)

    // Act
    const reloadedSettings = await createAiReviewSettingsStorage(store).load()

    // Assert
    expect(reloadedSettings.providers.claude.selectedModel).toBeNull()
  })
  it("loads_settings_saved_before_the_chat_existed_with_the_terminal_surface", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const settingsSavedBeforeChat = {
      defaultProvider: null,
      defaultProfile: "balanced",
      providers: {
        claude: { selectedModel: "opus", successfulModelIds: [] },
        codex: { selectedModel: "gpt-5.6-sol", successfulModelIds: [] },
      },
      codexModelDefaultApplied: true,
      claudeModelDefaultApplied: true,
      terminalProvider: "claude",
    }
    await store.set("ai-review:settings", JSON.stringify(settingsSavedBeforeChat))

    // Act
    const settings = await storage.load()

    // Assert
    const expected = { ...settingsSavedBeforeChat, panelSurface: "terminal" }
    expect(settings).toEqual(expected)
  })

  it("remembers_the_saved_panel_surface", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewSettingsStorage(store)
    const panelSurface = "chat"

    // Act
    await storage.savePanelSurface(panelSurface)
    const reloadedSettings = await createAiReviewSettingsStorage(store).load()

    // Assert
    expect(reloadedSettings.panelSurface).toBe(panelSurface)
  })
})
