import {
  type AiProviderId,
  type ChatTurnInput,
  type ChatTurnOutput,
  type ProviderCapabilities,
  type ProviderConfiguration,
  type ReviewEventSink,
  type ReviewRunInput,
  type ReviewRunOutput,
  chatTurnInputSchema,
  providerConfigurationSchema,
  reviewRunInputSchema,
} from "@pr-visulizer/shared"

import type { AppAiReviewProvider } from "./provider"

const FAKE_PROVIDER_ID: AiProviderId = "fake"
const FAKE_CLI_VERSION = "1.0.0"
const FAKE_MODEL = "fake-model"

export class FakeProviderCancelledError extends Error {
  constructor(runId: string) {
    super(`Fake AI review run ${runId} was cancelled`)
    this.name = "FakeProviderCancelledError"
  }
}

function unavailableCapabilities(): ProviderCapabilities {
  return {
    available: false,
    executablePath: null,
    cliVersion: null,
    missingCapabilities: ["fake provider configuration"],
    warning: null,
  }
}

function completedOutput(): ReviewRunOutput {
  return {
    summary: "Fake provider completed the review.",
    findings: [
      {
        id: "fake-unanchored-observation",
        title: "Review the boundary conditions",
        severity: "low",
        confidence: "high",
        category: "correctness",
        path: null,
        side: null,
        startLine: null,
        endLine: null,
        evidence: "The deterministic fixture has no repository patch to anchor.",
        impact: "A reviewer should confirm edge-case behavior before merging.",
        suggestedFix: null,
        source: "code-review",
      },
    ],
    requirementCoverage: null,
    coverage: {
      reviewedPaths: [],
      skipped: [],
      failedChunks: [],
      missingContent: [],
      excludedSensitivePaths: [],
      synthesisCompleted: true,
    },
    usage: {
      elapsedMs: 0,
      parentAgentCount: 1,
      nestedAgentCount: 0,
      toolEventCount: 0,
      approvedCommandCount: 0,
      inputTokens: null,
      outputTokens: null,
      providerCost: null,
    },
    reportedModel: FAKE_MODEL,
  }
}

function ensureFakeConfiguration(configuration: ProviderConfiguration): void {
  if (configuration.provider !== FAKE_PROVIDER_ID) {
    throw new Error("The fake provider only accepts fake provider configuration")
  }
}

// This adapter is intentionally deterministic and process-free. It provides stable review/chat
// fixtures for the Tauri lifecycle while the Rust broker is built in later slices.
export function createFakeAiReviewProvider(): AppAiReviewProvider {
  const cancelledRunIds = new Set<string>()

  const throwIfCancelled = (runId: string): void => {
    if (cancelledRunIds.has(runId)) throw new FakeProviderCancelledError(runId)
  }

  return {
    id: FAKE_PROVIDER_ID,
    availability: "test-only",

    async probe(configuration: ProviderConfiguration): Promise<ProviderCapabilities> {
      const parsedConfiguration = providerConfigurationSchema.parse(configuration)
      if (parsedConfiguration.provider !== FAKE_PROVIDER_ID) return unavailableCapabilities()

      return {
        available: true,
        executablePath: null,
        cliVersion: FAKE_CLI_VERSION,
        missingCapabilities: [],
        warning: "Test-only deterministic provider; it cannot run a CLI.",
      }
    },

    async review(input: ReviewRunInput, events: ReviewEventSink): Promise<ReviewRunOutput> {
      const parsedInput = reviewRunInputSchema.parse(input)
      ensureFakeConfiguration(parsedInput.configuration)
      throwIfCancelled(parsedInput.runId)

      await events({
        type: "progress",
        runId: parsedInput.runId,
        message: "Preparing deterministic fake review",
      })
      throwIfCancelled(parsedInput.runId)

      await events({
        type: "diagnostic",
        runId: parsedInput.runId,
        message: "Fake provider produced schema-valid fixture output",
      })
      throwIfCancelled(parsedInput.runId)

      const output = completedOutput()
      await events({ type: "completed", runId: parsedInput.runId })
      return output
    },

    async chat(input: ChatTurnInput, _events: ReviewEventSink): Promise<ChatTurnOutput> {
      const parsedInput = chatTurnInputSchema.parse(input)
      ensureFakeConfiguration(parsedInput.configuration)

      return {
        message: `Fake ${parsedInput.scope} response: ${parsedInput.message}`,
        findingCandidate: null,
        reportedModel: FAKE_MODEL,
        usage: {
          elapsedMs: 0,
          parentAgentCount: 1,
          nestedAgentCount: 0,
          toolEventCount: 0,
          approvedCommandCount: 0,
          inputTokens: null,
          outputTokens: null,
          providerCost: null,
        },
      }
    },

    async cancel(runId: string): Promise<void> {
      cancelledRunIds.add(runId)
    },
  }
}
