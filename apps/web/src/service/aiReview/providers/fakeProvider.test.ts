import {
  type AiReviewEvent,
  type ChatTurnInput,
  type ProviderConfiguration,
  type ReviewRunInput,
  chatTurnOutputSchema,
  reviewRunOutputSchema,
} from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { createFakeAiReviewProvider } from "./fakeProvider"
import { isProductionProvider } from "./provider"

const fakeConfiguration: ProviderConfiguration = {
  provider: "fake",
  executablePath: null,
  selectedModel: null,
}

function createReviewInput(runId: string): ReviewRunInput {
  return {
    runId,
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    inputFingerprint: "input-fingerprint",
    contextSecurityFingerprint: "context-security-fingerprint",
    configuration: fakeConfiguration,
    profile: "balanced",
  }
}

function createChatInput(): ChatTurnInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    contextSecurityFingerprint: "context-security-fingerprint",
    configuration: fakeConfiguration,
    scope: "finding",
    message: "What should the reviewer check next?",
  }
}

describe("fake AI review provider", () => {
  it("completes a deterministic schema-valid review fixture without invoking a CLI", async () => {
    // Arrange
    const provider = createFakeAiReviewProvider()
    const reviewInput = createReviewInput("run-1")
    const reviewEvents: AiReviewEvent[] = []

    // Act
    const capabilities = await provider.probe(fakeConfiguration)
    const output = await provider.review(reviewInput, (event) => {
      reviewEvents.push(event)
    })

    // Assert
    expect(provider.id).toBe("fake")
    expect(provider.availability).toBe("test-only")
    expect(isProductionProvider(provider)).toBe(false)
    expect(capabilities).toEqual({
      available: true,
      executablePath: null,
      cliVersion: "1.0.0",
      missingCapabilities: [],
      warning: "Test-only deterministic provider; it cannot run a CLI.",
    })
    expect(reviewRunOutputSchema.parse(output)).toEqual(output)
    expect(reviewEvents).toEqual([
      { type: "progress", runId: "run-1", message: "Preparing deterministic fake review" },
      {
        type: "diagnostic",
        runId: "run-1",
        message: "Fake provider produced schema-valid fixture output",
      },
      { type: "completed", runId: "run-1" },
    ])
  })

  it("returns a deterministic schema-valid scoped chat response", async () => {
    // Arrange
    const provider = createFakeAiReviewProvider()
    const chatInput = createChatInput()
    const chatEvents: AiReviewEvent[] = []

    // Act
    const output = await provider.chat(chatInput, (event) => {
      chatEvents.push(event)
    })

    // Assert
    expect(chatTurnOutputSchema.parse(output)).toEqual(output)
    expect(output.message).toBe("Fake finding response: What should the reviewer check next?")
    expect(chatEvents).toEqual([])
  })

  it("does not silently fall back from a non-fake configuration and honors cancellation", async () => {
    // Arrange
    const provider = createFakeAiReviewProvider()
    const reviewInput = createReviewInput("run-to-cancel")
    const claudeConfiguration: ProviderConfiguration = {
      ...fakeConfiguration,
      provider: "claude",
    }
    const reviewEvents: AiReviewEvent[] = []

    // Act
    const unavailableCapabilities = await provider.probe(claudeConfiguration)
    const cancelledReview = provider.review(reviewInput, async (event) => {
      reviewEvents.push(event)
      if (event.type === "progress") await provider.cancel(reviewInput.runId)
    })

    // Assert
    expect(unavailableCapabilities).toEqual({
      available: false,
      executablePath: null,
      cliVersion: null,
      missingCapabilities: ["fake provider configuration"],
      warning: null,
    })
    await expect(cancelledReview).rejects.toThrow("Fake AI review run run-to-cancel was cancelled")
    expect(reviewEvents).toEqual([
      {
        type: "progress",
        runId: "run-to-cancel",
        message: "Preparing deterministic fake review",
      },
    ])
  })
})
