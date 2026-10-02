import type { ChatTurnInput, ProviderConfiguration, ReviewRunInput } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { CLAUDE_MISSING_SAFETY_CAPABILITIES, createClaudeAiReviewProvider } from "./claudeProvider"
import { isProductionProvider } from "./provider"

const claudeConfiguration: ProviderConfiguration = {
  provider: "claude",
  executablePath: "/opt/homebrew/bin/claude",
  selectedModel: null,
}

function createReviewInput(): ReviewRunInput {
  return {
    runId: "claude-run-1",
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    inputFingerprint: "input-fingerprint",
    contextSecurityFingerprint: "context-security-fingerprint",
    configuration: claudeConfiguration,
    profile: "balanced",
  }
}

function createChatInput(): ChatTurnInput {
  return {
    threadId: "claude-thread-1",
    runId: null,
    contextSecurityFingerprint: "context-security-fingerprint",
    configuration: claudeConfiguration,
    scope: "whole-pr",
    message: "Review this pull request.",
  }
}

describe("Claude AI review provider", () => {
  it("remains unavailable until every unproven design §19 safety capability has primary evidence", async () => {
    // Arrange
    const provider = createClaudeAiReviewProvider()

    // Act
    const capabilities = await provider.probe(claudeConfiguration)

    // Assert
    expect(provider.availability).toBe("unavailable")
    expect(isProductionProvider(provider)).toBe(false)
    expect(capabilities).toEqual({
      available: false,
      executablePath: null,
      cliVersion: "2.1.268",
      missingCapabilities: [...CLAUDE_MISSING_SAFETY_CAPABILITIES],
      warning:
        "Claude 2.1.268 remains unavailable: --bare leaves skills resolvable and shipped help does not prove every required design §19 safety boundary.",
    })
    expect(capabilities.missingCapabilities).toEqual([
      "app-owned provider state redirection and deletion boundaries",
      "structured output and sanitized event parsing",
      "broker-observable complete provider and nested-process tree cancellation",
      "enforceable nested-agent count/depth limits and observable usage",
      "independently broker-approvable exact repository commands",
      "independently broker-approvable MCP server startup and individual MCP tool calls",
      "complete suppression of automatic instruction loading, startup hooks, executable plugins, skills, custom agents, and MCP startup",
    ])
  })

  it("never starts a Claude review or chat while the capability gate is unavailable", async () => {
    // Arrange
    const provider = createClaudeAiReviewProvider()
    const reviewInput = createReviewInput()
    const chatInput = createChatInput()

    // Act
    const reviewAttempt = provider.review(reviewInput, () => undefined)
    const chatAttempt = provider.chat(chatInput, () => undefined)
    await provider.cancel(reviewInput.runId)

    // Assert
    await expect(reviewAttempt).rejects.toThrow(
      "Claude CLI is unavailable for AI review because its required safety capabilities are unproven"
    )
    await expect(chatAttempt).rejects.toThrow(
      "Claude CLI is unavailable for AI review because its required safety capabilities are unproven"
    )
  })
})
