// Repository-context policy is provider-neutral input to the desktop broker. It describes the
// source that MAY be disclosed; the Rust broker remains responsible for canonical filesystem
// checks, snapshot creation, and read-only enforcement.

export type RepositoryContextMode = "hard-exclusion" | "full-git-history"

export type AiRepositoryContextPolicy = {
  mode: RepositoryContextMode
  customExcludedPaths: string[]
  maxFileBytes: number
}

export type RepositoryFileCandidate = {
  path: string
  sizeBytes: number
  isBinary: boolean
  isSymlink: boolean
  // The broker supplies this only after canonicalizing the symlink target against the prepared
  // source root. An unresolved target is intentionally treated as unsafe by the pure policy.
  resolvesWithinSourceRoot: boolean | null
}

export type RepositoryContextExclusionReason =
  | "invalid-path"
  | "environment-file"
  | "credential-file"
  | "dependency-directory"
  | "generated-or-vendored-content"
  | "binary-file"
  | "oversized-file"
  | "symlink-outside-source-root"
  | "custom-exclusion"

export type RepositoryContextFileClassification =
  | { included: true; path: string }
  | {
      included: false
      path: string
      reason: RepositoryContextExclusionReason
    }

export type IsolatedSnapshotRequest = {
  sourceKind: "app-owned-temporary"
  sourcePath: string
  activeWorkingTreePath: string
  baseSha: string
  headSha: string
  sourceSha: string
  sourceReadOnly: boolean
  includesGitObjectDatabase: boolean
  policy: AiRepositoryContextPolicy
}

export type IsolatedSnapshotValidation =
  | {
      valid: true
      policy: AiRepositoryContextPolicy
    }
  | {
      valid: false
      errors: string[]
    }

// 1.5 MB matches the existing desktop deep-analysis source cap. Review callers can explicitly
// choose a lower cap, but cannot disable the size boundary with an invalid value.
export const DEFAULT_AI_REPOSITORY_CONTEXT_POLICY: AiRepositoryContextPolicy = {
  mode: "hard-exclusion",
  customExcludedPaths: [],
  maxFileBytes: 1_500_000,
}
