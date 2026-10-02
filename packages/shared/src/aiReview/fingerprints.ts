import { z } from "zod"

import {
  aiProviderIdSchema,
  aiReviewTargetSchema,
  reviewProfileSchema,
} from "../entities/aiReview.js"

// Fingerprint inputs contain stable digests rather than raw repository, PR, Jira, or instruction
// text. The callers own snapshotting that untrusted text; this core only establishes whether the
// exact disclosed inputs and policies are compatible with a stored run or provider session.
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const provenanceFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const reviewInputFingerprintSchema = z
  .object({
    target: aiReviewTargetSchema,
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    diffDigest: digestSchema,
    prMetadataDigest: digestSchema,
    githubCommentsDigest: digestSchema,
    selectedJiraSnapshotDigest: digestSchema.nullable(),
    priorFeedback: z.object({
      enabled: z.boolean(),
      digest: digestSchema.nullable(),
    }),
    effectiveInstructionsDigest: digestSchema,
    contextPolicyDigest: digestSchema,
    securityPolicyDigest: digestSchema,
    provider: aiProviderIdSchema,
    providerAdapterVersion: z.string().min(1),
    cliVersion: z.string().min(1),
    // Codex contexts bind the broker-observed receipt fingerprint rather than trusting a
    // hardcoded CLI version string. Other provider contexts have no broker receipt.
    observedProvenanceFingerprint: provenanceFingerprintSchema.nullable(),
    selectedModel: z.string().min(1).nullable(),
    profile: reviewProfileSchema,
    promptVersion: z.string().min(1),
    chunkingPolicyDigest: digestSchema,
  })
  .superRefine((input, context) => {
    if (input.priorFeedback.enabled && !input.priorFeedback.digest) {
      context.addIssue({
        code: "custom",
        message: "Enabled prior feedback requires its content digest",
        path: ["priorFeedback", "digest"],
      })
    }
    if (input.provider === "codex" && input.observedProvenanceFingerprint === null) {
      context.addIssue({
        code: "custom",
        message: "Codex review fingerprints require the observed provenance receipt fingerprint",
        path: ["observedProvenanceFingerprint"],
      })
    }
  })
export type ReviewInputFingerprintInput = z.infer<typeof reviewInputFingerprintSchema>

export const contextSecurityFingerprintSchema = z
  .object({
    target: aiReviewTargetSchema,
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    disclosedSourceDigest: digestSchema,
    disclosedHistoryDigest: digestSchema,
    effectiveInstructionsDigest: digestSchema,
    provider: aiProviderIdSchema,
    providerAdapterVersion: z.string().min(1),
    cliVersion: z.string().min(1),
    observedProvenanceFingerprint: provenanceFingerprintSchema.nullable(),
    selectedModel: z.string().min(1).nullable(),
    selectedJiraSnapshotDigest: digestSchema.nullable(),
    contextPolicyDigest: digestSchema,
    securityPolicyDigest: digestSchema,
    permissionsDigest: digestSchema,
  })
  .superRefine((input, context) => {
    // A Codex context cannot be rebuilt against a receipt-free identity. Keep this check separate
    // from the structural schema so non-broker providers retain their provider-neutral contract.
    if (input.provider === "codex" && input.observedProvenanceFingerprint === null) {
      context.addIssue({
        code: "custom",
        message: "Codex context fingerprints require the observed provenance receipt fingerprint",
        path: ["observedProvenanceFingerprint"],
      })
    }
  })
export type ContextSecurityFingerprintInput = z.infer<typeof contextSecurityFingerprintSchema>

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue }

type DigestApi = {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>
}

type TextEncoderApi = new () => {
  encode(input: string): Uint8Array
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON does not support non-finite numbers")
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",")}}`
}

function getCryptoSubtle(): DigestApi {
  const crypto = (globalThis as { crypto?: { subtle?: DigestApi } }).crypto
  if (!crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable")

  return crypto.subtle
}

function getTextEncoder(): TextEncoderApi {
  const TextEncoder = (globalThis as { TextEncoder?: TextEncoderApi }).TextEncoder
  if (!TextEncoder) throw new Error("TextEncoder is unavailable")

  return TextEncoder
}

async function sha256(value: string): Promise<string> {
  const bytes = new (getTextEncoder())().encode(value)
  const digest = await getCryptoSubtle().digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

  return `sha256:${hex}`
}

// Object keys are sorted recursively while arrays stay in their supplied order because array
// order can carry instruction precedence or chat-history meaning. Inputs use content digests, so
// no raw untrusted text is normalized, trimmed, or interpreted as safety configuration.
export function canonicalizeFingerprintInput(input: JsonValue): string {
  return canonicalJson(input)
}

export async function createReviewInputFingerprint(
  input: ReviewInputFingerprintInput
): Promise<string> {
  const parsedInput = reviewInputFingerprintSchema.parse(input)
  return sha256(`ai-review-input:v1:${canonicalJson(parsedInput)}`)
}

export async function createContextSecurityFingerprint(
  input: ContextSecurityFingerprintInput
): Promise<string> {
  const parsedInput = contextSecurityFingerprintSchema.parse(input)
  return sha256(`ai-context-security:v1:${canonicalJson(parsedInput)}`)
}
