import type { ChatTurnInput, ProviderConfiguration, ReviewRunInput } from "@pr-visulizer/shared"
import { describe, expect, it, vi } from "vitest"

import type { CodexSafeProfileBridge } from "../codexSafeProfileBridge"
import {
  CODEX_SAFE_PROFILE_DISABLED_CAPABILITIES,
  createCodexAiReviewProvider,
} from "./codexProvider"
import { isProductionProvider } from "./provider"

const codexConfiguration: ProviderConfiguration = {
  provider: "codex",
  executablePath: "/untrusted/webview/codex",
  selectedModel: null,
}

function createReviewInput(): ReviewRunInput {
  return {
    runId: "codex-run-1",
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    inputFingerprint: "input-fingerprint",
    contextSecurityFingerprint: "context-security-fingerprint",
    configuration: codexConfiguration,
    profile: "balanced",
  }
}

function createChatInput(): ChatTurnInput {
  return {
    threadId: "codex-thread-1",
    runId: null,
    contextSecurityFingerprint: "context-security-fingerprint",
    configuration: codexConfiguration,
    scope: "whole-pr",
    message: "Review this pull request.",
  }
}

function createCompatibleRuntimeGateBridge(): CodexSafeProfileBridge {
  return {
    capability: vi.fn(async () => ({
      available: true,
      cliVersion: "0.153.4",
      coreControlsVerified: true,
      provenance: {
        executableIdentityDigest: "a".repeat(64),
        cliVersion: "0.153.4",
        helpDigest: "b".repeat(64),
        safeProfileRevision: "codex-safe-profile-r2",
        provenanceFingerprint: "d".repeat(64),
      },
      receiptId: "test-receipt",
      diagnostics: [],
    })),
    run: vi.fn(),
    cancel: vi.fn(async () => undefined),
  }
}

describe("Codex AI review provider", () => {
  it("provider_rejects_a_nonexact_or_rejected_broker_receipt_before_admission", async () => {
    // Arrange
    const bridge: CodexSafeProfileBridge = {
      ...createCompatibleRuntimeGateBridge(),
      capability: vi.fn(async () => ({
        available: false,
        cliVersion: "0.153.4",
        coreControlsVerified: true,
        provenance: {
          executableIdentityDigest: "a".repeat(64),
          cliVersion: "0.153.4",
          helpDigest: "b".repeat(64),
          safeProfileRevision: "codex-safe-profile-r2",
          provenanceFingerprint: "d".repeat(64),
        },
        receiptId: "previously-compatible-receipt",
        diagnostics: ["Codex safe-profile exact compatibility receipt was rejected."],
      })),
    }
    const provider = createCodexAiReviewProvider({ bridge })

    // Act
    const capability = await provider.probe(codexConfiguration)

    // Assert
    expect(provider.availability).toBe("production")
    expect(isProductionProvider(provider)).toBe(true)
    expect(capability).toEqual({
      available: false,
      executablePath: null,
      cliVersion: "0.153.4",
      observedProvenance: {
        executableIdentityDigest: "a".repeat(64),
        cliVersion: "0.153.4",
        helpDigest: "b".repeat(64),
        safeProfileRevision: "codex-safe-profile-r2",
        provenanceFingerprint: "d".repeat(64),
      },
      missingCapabilities: [
        "Codex safe-profile exact compatibility receipt was rejected.",
        ...CODEX_SAFE_PROFILE_DISABLED_CAPABILITIES,
      ],
      warning:
        "Codex prompt-only safe profile is unavailable because its exact broker compatibility receipt was rejected.",
    })
    expect(bridge.capability).toHaveBeenCalledOnce()
    expect(bridge.run).not.toHaveBeenCalled()
    expect(CODEX_SAFE_PROFILE_DISABLED_CAPABILITIES).toEqual([
      "repository commands",
      "MCP startup and tool calls",
      "hooks",
      "plugins",
      "skills",
      "custom agents",
      "nested agents",
      "web search",
      "code editing",
      "automatic updates",
    ])
  })

  it("rejects_an_available_claim_for_a_newer_cli_without_using_its_receipt", async () => {
    // Arrange
    const bridge: CodexSafeProfileBridge = {
      ...createCompatibleRuntimeGateBridge(),
      capability: vi.fn(async () => ({
        available: true,
        cliVersion: "0.153.5",
        coreControlsVerified: true,
        provenance: {
          executableIdentityDigest: "a".repeat(64),
          cliVersion: "0.153.5",
          helpDigest: "b".repeat(64),
          safeProfileRevision: "codex-safe-profile-r2",
          provenanceFingerprint: "d".repeat(64),
        },
        receiptId: "newer-receipt",
        diagnostics: [],
      })),
    }
    const provider = createCodexAiReviewProvider({ bridge })

    // Act
    const capability = await provider.probe(codexConfiguration)

    // Assert
    expect(capability.available).toBe(false)
    expect(capability.warning).toContain("exact broker compatibility receipt")
    expect(bridge.run).not.toHaveBeenCalled()
  })

  it("ignores webview executable paths and defers execution until revision-pinned context exists", async () => {
    // Arrange
    const bridge = createCompatibleRuntimeGateBridge()
    const provider = createCodexAiReviewProvider({ bridge })
    const reviewInput = createReviewInput()
    const chatInput = createChatInput()

    // Act
    const reviewAttempt = provider.review(reviewInput, () => undefined)
    const chatAttempt = provider.chat(chatInput, () => undefined)
    await provider.cancel(reviewInput.runId)

    // Assert
    await expect(reviewAttempt).rejects.toThrow(
      "Codex safe-profile execution requires app-owned revision-pinned context"
    )
    await expect(chatAttempt).rejects.toThrow(
      "Codex safe-profile execution requires app-owned revision-pinned context"
    )
    expect(bridge.run).not.toHaveBeenCalled()
    expect(bridge.cancel).toHaveBeenCalledWith(reviewInput.runId)
  })
})
