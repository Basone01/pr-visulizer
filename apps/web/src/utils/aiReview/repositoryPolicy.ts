import {
  DEPENDENCY_DIRECTORIES,
  GENERATED_DIRECTORIES,
  GENERATED_FILE_SUFFIXES,
} from "@pr-visulizer/shared"

import type {
  AiRepositoryContextPolicy,
  IsolatedSnapshotRequest,
  IsolatedSnapshotValidation,
  RepositoryContextExclusionReason,
  RepositoryContextFileClassification,
  RepositoryFileCandidate,
} from "@/entity/aiReviewPolicy"

const CREDENTIAL_FILE_NAMES = new Set([
  ".npmrc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
])
const CREDENTIAL_FILE_EXTENSIONS = [".key", ".keystore", ".p12", ".pem", ".pfx"]

function normalizeRepositoryPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null
  }

  return normalized
}

function normalizedCustomExclusions(policy: AiRepositoryContextPolicy): string[] {
  return policy.customExcludedPaths.map((path) => {
    const normalized = normalizeRepositoryPath(path)
    if (!normalized)
      throw new Error(`Custom repository exclusion is not repository-relative: ${path}`)
    return normalized
  })
}

function customExclusionMatches(path: string, exclusions: string[]): boolean {
  return exclusions.some(
    (excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}/`)
  )
}

function firstSensitivePathReason(
  candidate: RepositoryFileCandidate,
  normalizedPath: string,
  customExclusions: string[]
): RepositoryContextExclusionReason | null {
  const segments = normalizedPath.split("/")
  const fileName = segments.at(-1)!.toLowerCase()

  if (customExclusionMatches(normalizedPath, customExclusions)) return "custom-exclusion"
  if (segments.some((segment) => DEPENDENCY_DIRECTORIES.has(segment.toLowerCase()))) {
    return "dependency-directory"
  }
  if (segments.some((segment) => GENERATED_DIRECTORIES.has(segment.toLowerCase()))) {
    return "generated-or-vendored-content"
  }
  if (fileName.startsWith(".env")) return "environment-file"
  if (
    CREDENTIAL_FILE_NAMES.has(fileName) ||
    CREDENTIAL_FILE_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  ) {
    return "credential-file"
  }
  if (GENERATED_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return "generated-or-vendored-content"
  }
  if (candidate.isSymlink && candidate.resolvesWithinSourceRoot !== true) {
    return "symlink-outside-source-root"
  }
  if (candidate.isBinary) return "binary-file"

  return null
}

export function classifyRepositoryContextFile(
  candidate: RepositoryFileCandidate,
  policy: AiRepositoryContextPolicy
): RepositoryContextFileClassification {
  const normalizedPath = normalizeRepositoryPath(candidate.path)
  if (!normalizedPath) return { included: false, path: candidate.path, reason: "invalid-path" }
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 0) {
    return { included: false, path: normalizedPath, reason: "oversized-file" }
  }
  if (!Number.isSafeInteger(policy.maxFileBytes) || policy.maxFileBytes <= 0) {
    throw new Error("Repository context policy requires a positive integer maxFileBytes")
  }

  const sensitiveReason = firstSensitivePathReason(
    candidate,
    normalizedPath,
    normalizedCustomExclusions(policy)
  )
  if (sensitiveReason) return { included: false, path: normalizedPath, reason: sensitiveReason }
  if (candidate.sizeBytes > policy.maxFileBytes) {
    return { included: false, path: normalizedPath, reason: "oversized-file" }
  }

  return { included: true, path: normalizedPath }
}

export function filterRepositoryContextFiles(
  candidates: RepositoryFileCandidate[],
  policy: AiRepositoryContextPolicy
): RepositoryContextFileClassification[] {
  return candidates.map((candidate) => classifyRepositoryContextFile(candidate, policy))
}

function normalizedAbsolutePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  const isWindowsAbsolutePath = /^[A-Za-z]:\//.test(normalized)
  if (!normalized || (!normalized.startsWith("/") && !isWindowsAbsolutePath)) return null

  return normalized
}

// This validates the browser-to-broker request shape before process work begins. Rust still
// canonicalizes paths and applies the read-only snapshot because string validation cannot prove
// filesystem identity or permissions.
export function validateIsolatedSnapshotRequest(
  request: IsolatedSnapshotRequest
): IsolatedSnapshotValidation {
  const errors: string[] = []
  const sourcePath = normalizedAbsolutePath(request.sourcePath)
  const activeWorkingTreePath = normalizedAbsolutePath(request.activeWorkingTreePath)

  if (request.sourceKind !== "app-owned-temporary") {
    errors.push("Snapshot source must be app-owned temporary storage")
  }
  if (!sourcePath) errors.push("Snapshot source path must be absolute")
  if (!activeWorkingTreePath) errors.push("Active working tree path must be absolute")
  if (sourcePath && activeWorkingTreePath && sourcePath === activeWorkingTreePath) {
    errors.push("Snapshot source must not be the active working tree")
  }
  if (!request.baseSha || !request.headSha || !request.sourceSha) {
    errors.push("Snapshot request requires base, head, and source SHAs")
  }
  if (request.sourceSha !== request.headSha) {
    errors.push("Snapshot source SHA must equal the requested PR head SHA")
  }
  if (!request.sourceReadOnly) errors.push("Snapshot source must be read-only")
  if (request.policy.mode === "hard-exclusion" && request.includesGitObjectDatabase) {
    errors.push("Hard exclusion snapshots must not include a Git object database")
  }
  if (request.policy.mode === "full-git-history" && !request.includesGitObjectDatabase) {
    errors.push("Full Git history snapshots must include the Git object database")
  }

  try {
    normalizedCustomExclusions(request.policy)
    if (!Number.isSafeInteger(request.policy.maxFileBytes) || request.policy.maxFileBytes <= 0) {
      errors.push("Repository context policy requires a positive integer maxFileBytes")
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Repository context policy is invalid")
  }

  return errors.length === 0
    ? {
        valid: true,
        policy: {
          ...request.policy,
          customExcludedPaths: normalizedCustomExclusions(request.policy),
        },
      }
    : { valid: false, errors }
}
