import {
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

const CLAUDE_PROVIDER_VERSION_EVIDENCE = "2.1.268"

// These are the specific design §19 boundaries that the installed Claude CLI help cannot prove.
// The adapter stays unavailable until primary evidence proves every one without relying on `--bare`.
export const CLAUDE_MISSING_SAFETY_CAPABILITIES = [
  "app-owned provider state redirection and deletion boundaries",
  "structured output and sanitized event parsing",
  "broker-observable complete provider and nested-process tree cancellation",
  "enforceable nested-agent count/depth limits and observable usage",
  "independently broker-approvable exact repository commands",
  "independently broker-approvable MCP server startup and individual MCP tool calls",
  "complete suppression of automatic instruction loading, startup hooks, executable plugins, skills, custom agents, and MCP startup",
] as const

export class ClaudeProviderUnavailableError extends Error {
  constructor() {
    super(
      "Claude CLI is unavailable for AI review because its required safety capabilities are unproven"
    )
    this.name = "ClaudeProviderUnavailableError"
  }
}

function unavailableCapabilities(): ProviderCapabilities {
  return {
    available: false,
    executablePath: null,
    cliVersion: CLAUDE_PROVIDER_VERSION_EVIDENCE,
    missingCapabilities: [...CLAUDE_MISSING_SAFETY_CAPABILITIES],
    warning:
      "Claude 2.1.268 remains unavailable: --bare leaves skills resolvable and shipped help does not prove every required design §19 safety boundary.",
  }
}

function ensureClaudeConfiguration(configuration: ProviderConfiguration): void {
  if (configuration.provider !== "claude") {
    throw new Error("The Claude provider only accepts Claude provider configuration")
  }
}

// This deliberately never starts Claude or exposes a CLI command. Rust broker discovery reports
// executable facts, while this provider reports the fail-closed capability result to the UI.
export function createClaudeAiReviewProvider(): AppAiReviewProvider {
  return {
    id: "claude",
    availability: "unavailable",

    async probe(configuration: ProviderConfiguration): Promise<ProviderCapabilities> {
      const parsedConfiguration = providerConfigurationSchema.parse(configuration)
      if (parsedConfiguration.provider !== "claude") {
        return {
          available: false,
          executablePath: null,
          cliVersion: null,
          missingCapabilities: ["claude provider configuration"],
          warning: null,
        }
      }

      return unavailableCapabilities()
    },

    async review(input: ReviewRunInput, _events: ReviewEventSink): Promise<ReviewRunOutput> {
      const parsedInput = reviewRunInputSchema.parse(input)
      ensureClaudeConfiguration(parsedInput.configuration)
      throw new ClaudeProviderUnavailableError()
    },

    async chat(input: ChatTurnInput, _events: ReviewEventSink): Promise<ChatTurnOutput> {
      const parsedInput = chatTurnInputSchema.parse(input)
      ensureClaudeConfiguration(parsedInput.configuration)
      throw new ClaudeProviderUnavailableError()
    },

    async cancel(_runId: string): Promise<void> {
      // No process can exist while this fail-closed adapter is unavailable.
    },
  }
}
