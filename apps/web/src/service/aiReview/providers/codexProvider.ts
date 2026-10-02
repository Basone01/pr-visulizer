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

import {
  type CodexSafeProfileBridge,
  type CodexSafeProfileCapability,
  createCodexSafeProfileBridge,
} from "../codexSafeProfileBridge"
import type { AppAiReviewProvider } from "./provider"

// The provider repeats only public compatibility facts. Rust remains authoritative for the
// descriptor and help digest bound into the opaque receipt.
const CODEX_SAFE_PROFILE_EXACT_CLI_VERSION = "0.153.4"
const CODEX_SAFE_PROFILE_SAFE_PROFILE_REVISION = "codex-safe-profile-r2"

// These controls are intentionally unsupported by the prompt-only profile. They remain visible
// as degraded capabilities so their absence cannot be mistaken for a broker or CLI failure.
export const CODEX_SAFE_PROFILE_DISABLED_CAPABILITIES = [
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
] as const

export class CodexSafeProfileContextRequiredError extends Error {
  constructor() {
    super("Codex safe-profile execution requires app-owned revision-pinned context")
    this.name = "CodexSafeProfileContextRequiredError"
  }
}

function unavailableCapabilities(
  capability: Pick<CodexSafeProfileCapability, "cliVersion" | "diagnostics" | "provenance">
): ProviderCapabilities {
  return {
    available: false,
    executablePath: null,
    // The Rust broker observes this from its fixed version probe; the webview never selects it.
    cliVersion: capability.cliVersion,
    observedProvenance: capability.provenance ?? undefined,
    missingCapabilities: [...capability.diagnostics, ...CODEX_SAFE_PROFILE_DISABLED_CAPABILITIES],
    warning:
      "Codex prompt-only safe profile is unavailable because its exact broker compatibility receipt was rejected.",
  }
}

function availableCapabilities(
  cliVersion: string,
  observedProvenance: NonNullable<CodexSafeProfileCapability["provenance"]>
): ProviderCapabilities {
  return {
    available: true,
    executablePath: null,
    cliVersion,
    observedProvenance,
    missingCapabilities: [...CODEX_SAFE_PROFILE_DISABLED_CAPABILITIES],
    warning:
      "Prompt-only safe profile: commands, MCP, hooks, plugins, skills, custom agents, nested agents, web search, edits, and automatic updates are disabled.",
  }
}

function ensureCodexConfiguration(configuration: ProviderConfiguration): void {
  if (configuration.provider !== "codex") {
    throw new Error("The Codex provider only accepts Codex provider configuration")
  }
  // `executablePath` is intentionally ignored. Only the Rust broker resolves the fixed Codex
  // executable from the adopted login-shell PATH; no webview value participates in resolution.
}

export type CodexAiReviewProviderDeps = {
  bridge?: CodexSafeProfileBridge
}

// S55 establishes availability grading only. S56 supplies the bounded, app-owned PR/Jira prompt
// and routes the bridge terminal value through revision-pinned validation before this adapter
// executes a review or chat turn.
export function createCodexAiReviewProvider(
  deps: CodexAiReviewProviderDeps = {}
): AppAiReviewProvider {
  const bridge = deps.bridge ?? createCodexSafeProfileBridge()

  return {
    id: "codex",
    availability: "production",

    async probe(configuration: ProviderConfiguration): Promise<ProviderCapabilities> {
      const parsedConfiguration = providerConfigurationSchema.parse(configuration)
      if (parsedConfiguration.provider !== "codex") {
        return {
          available: false,
          executablePath: null,
          cliVersion: null,
          missingCapabilities: ["codex provider configuration"],
          warning: null,
        }
      }

      try {
        const capability = await bridge.capability()
        return capability.available &&
          capability.cliVersion === CODEX_SAFE_PROFILE_EXACT_CLI_VERSION &&
          capability.coreControlsVerified &&
          capability.provenance &&
          capability.receiptId &&
          capability.provenance.provenanceFingerprint &&
          capability.provenance.cliVersion === capability.cliVersion &&
          capability.provenance.safeProfileRevision === CODEX_SAFE_PROFILE_SAFE_PROFILE_REVISION
          ? availableCapabilities(capability.cliVersion, capability.provenance)
          : unavailableCapabilities(capability)
      } catch {
        return unavailableCapabilities({
          cliVersion: null,
          diagnostics: ["Codex safe-profile broker capability is unavailable"],
        })
      }
    },

    async review(input: ReviewRunInput, _events: ReviewEventSink): Promise<ReviewRunOutput> {
      const parsedInput = reviewRunInputSchema.parse(input)
      ensureCodexConfiguration(parsedInput.configuration)
      throw new CodexSafeProfileContextRequiredError()
    },

    async chat(input: ChatTurnInput, _events: ReviewEventSink): Promise<ChatTurnOutput> {
      const parsedInput = chatTurnInputSchema.parse(input)
      ensureCodexConfiguration(parsedInput.configuration)
      throw new CodexSafeProfileContextRequiredError()
    },

    async cancel(runId: string): Promise<void> {
      await bridge.cancel(runId)
    },
  }
}
