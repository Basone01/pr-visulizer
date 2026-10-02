import { describe, expect, it } from "vitest"

import {
  type ContextSecurityFingerprintInput,
  type ReviewInputFingerprintInput,
  canonicalizeFingerprintInput,
  createContextSecurityFingerprint,
  createReviewInputFingerprint,
  reviewInputFingerprintSchema,
} from "../src/index.js"

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
}

const reviewInput: ReviewInputFingerprintInput = {
  target: { owner: "acme", repo: "web", number: 42 },
  baseSha: "base0000",
  headSha: "head1111",
  diffDigest: digest("a"),
  prMetadataDigest: digest("b"),
  githubCommentsDigest: digest("c"),
  selectedJiraSnapshotDigest: digest("d"),
  priorFeedback: { enabled: true, digest: digest("e") },
  effectiveInstructionsDigest: digest("f"),
  contextPolicyDigest: digest("0"),
  securityPolicyDigest: digest("1"),
  provider: "fake",
  providerAdapterVersion: "fake-adapter-v1",
  cliVersion: "1.0.0",
  observedProvenanceFingerprint: null,
  selectedModel: "fake-model",
  profile: "balanced",
  promptVersion: "review-v1",
  chunkingPolicyDigest: digest("2"),
}

const contextInput: ContextSecurityFingerprintInput = {
  target: reviewInput.target,
  baseSha: reviewInput.baseSha,
  headSha: reviewInput.headSha,
  disclosedSourceDigest: digest("3"),
  disclosedHistoryDigest: digest("4"),
  effectiveInstructionsDigest: reviewInput.effectiveInstructionsDigest,
  provider: reviewInput.provider,
  providerAdapterVersion: reviewInput.providerAdapterVersion,
  cliVersion: reviewInput.cliVersion,
  observedProvenanceFingerprint: reviewInput.observedProvenanceFingerprint,
  selectedModel: reviewInput.selectedModel,
  selectedJiraSnapshotDigest: reviewInput.selectedJiraSnapshotDigest,
  contextPolicyDigest: reviewInput.contextPolicyDigest,
  securityPolicyDigest: reviewInput.securityPolicyDigest,
  permissionsDigest: digest("5"),
}

describe("AI review fingerprints", () => {
  it("canonicalizes object keys while preserving meaningful array order", () => {
    // Arrange
    const firstInput = { nested: { beta: 2, alpha: 1 }, paths: ["a", "b"] }
    const secondInput = { paths: ["a", "b"], nested: { alpha: 1, beta: 2 } }
    const reorderedPaths = { nested: { alpha: 1, beta: 2 }, paths: ["b", "a"] }

    // Act
    const firstCanonical = canonicalizeFingerprintInput(firstInput)
    const secondCanonical = canonicalizeFingerprintInput(secondInput)
    const reorderedCanonical = canonicalizeFingerprintInput(reorderedPaths)

    // Assert
    expect(firstCanonical).toBe(secondCanonical)
    expect(reorderedCanonical).not.toBe(firstCanonical)
  })

  it("invalidates a cached review for every canonical review-input factor", async () => {
    // Arrange
    const changedInputs: ReviewInputFingerprintInput[] = [
      { ...reviewInput, baseSha: "base2222" },
      { ...reviewInput, headSha: "head2222" },
      { ...reviewInput, diffDigest: digest("6") },
      { ...reviewInput, prMetadataDigest: digest("7") },
      { ...reviewInput, githubCommentsDigest: digest("8") },
      { ...reviewInput, selectedJiraSnapshotDigest: digest("9") },
      { ...reviewInput, priorFeedback: { enabled: true, digest: digest("a") } },
      { ...reviewInput, effectiveInstructionsDigest: digest("b") },
      { ...reviewInput, contextPolicyDigest: digest("c") },
      { ...reviewInput, securityPolicyDigest: digest("d") },
      { ...reviewInput, provider: "claude" },
      { ...reviewInput, providerAdapterVersion: "fake-adapter-v2" },
      { ...reviewInput, cliVersion: "2.0.0" },
      { ...reviewInput, observedProvenanceFingerprint: "a".repeat(64) },
      { ...reviewInput, selectedModel: "another-model" },
      { ...reviewInput, profile: "thorough" },
      { ...reviewInput, promptVersion: "review-v2" },
      { ...reviewInput, chunkingPolicyDigest: digest("e") },
    ]

    // Act
    const baseline = await createReviewInputFingerprint(reviewInput)
    const changedFingerprints = await Promise.all(changedInputs.map(createReviewInputFingerprint))

    // Assert
    expect(new Set(changedFingerprints)).not.toContain(baseline)
    expect(
      reviewInputFingerprintSchema.safeParse({
        ...reviewInput,
        priorFeedback: { enabled: true, digest: null },
      }).success
    ).toBe(false)
  })

  it("forces a fresh provider session when disclosed context or security changes", async () => {
    // Arrange
    const changedInputs: ContextSecurityFingerprintInput[] = [
      { ...contextInput, baseSha: "base2222" },
      { ...contextInput, headSha: "head2222" },
      { ...contextInput, disclosedSourceDigest: digest("6") },
      { ...contextInput, disclosedHistoryDigest: digest("7") },
      { ...contextInput, effectiveInstructionsDigest: digest("8") },
      {
        ...contextInput,
        provider: "codex",
        observedProvenanceFingerprint: "a".repeat(64),
      },
      { ...contextInput, providerAdapterVersion: "fake-adapter-v2" },
      { ...contextInput, cliVersion: "2.0.0" },
      { ...contextInput, observedProvenanceFingerprint: "a".repeat(64) },
      { ...contextInput, selectedModel: null },
      { ...contextInput, selectedJiraSnapshotDigest: null },
      { ...contextInput, contextPolicyDigest: digest("9") },
      { ...contextInput, securityPolicyDigest: digest("a") },
      { ...contextInput, permissionsDigest: digest("b") },
    ]

    // Act
    const baseline = await createContextSecurityFingerprint(contextInput)
    const changedFingerprints = await Promise.all(
      changedInputs.map(createContextSecurityFingerprint)
    )

    // Assert
    expect(new Set(changedFingerprints)).not.toContain(baseline)
  })
})
