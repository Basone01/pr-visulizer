import { describe, expect, it } from "vitest"

import type { AiRepositoryContextPolicy, IsolatedSnapshotRequest } from "@/entity/aiReviewPolicy"

import {
  classifyRepositoryContextFile,
  filterRepositoryContextFiles,
  validateIsolatedSnapshotRequest,
} from "./repositoryPolicy"

const hardExclusionPolicy: AiRepositoryContextPolicy = {
  mode: "hard-exclusion",
  customExcludedPaths: ["internal/restricted"],
  maxFileBytes: 100,
}

function createSnapshotRequest(
  overrides: Partial<IsolatedSnapshotRequest> = {}
): IsolatedSnapshotRequest {
  return {
    sourceKind: "app-owned-temporary",
    sourcePath: "/tmp/prv-ai/owner/repo/head",
    activeWorkingTreePath: "/Users/reviewer/src/repo",
    baseSha: "base-sha",
    headSha: "head-sha",
    sourceSha: "head-sha",
    sourceReadOnly: true,
    includesGitObjectDatabase: false,
    policy: hardExclusionPolicy,
    ...overrides,
  }
}

describe("repository context policy", () => {
  it("excludes sensitive files before a hard-exclusion snapshot can disclose them", () => {
    // Arrange
    const candidates = [
      {
        path: ".env.local",
        sizeBytes: 10,
        isBinary: false,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
      {
        path: "keys/deploy.pem",
        sizeBytes: 10,
        isBinary: false,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
      {
        path: "node_modules/pkg/index.js",
        sizeBytes: 10,
        isBinary: false,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
      {
        path: "src/generated/client.ts",
        sizeBytes: 10,
        isBinary: false,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
      {
        path: "assets/logo.png",
        sizeBytes: 10,
        isBinary: true,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
      {
        path: "src/large.ts",
        sizeBytes: 101,
        isBinary: false,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
      {
        path: "src/external.ts",
        sizeBytes: 10,
        isBinary: false,
        isSymlink: true,
        resolvesWithinSourceRoot: false,
      },
      {
        path: "src/review.ts",
        sizeBytes: 10,
        isBinary: false,
        isSymlink: false,
        resolvesWithinSourceRoot: null,
      },
    ]

    // Act
    const classifications = filterRepositoryContextFiles(candidates, hardExclusionPolicy)

    // Assert
    expect(classifications).toEqual([
      { included: false, path: ".env.local", reason: "environment-file" },
      { included: false, path: "keys/deploy.pem", reason: "credential-file" },
      { included: false, path: "node_modules/pkg/index.js", reason: "dependency-directory" },
      { included: false, path: "src/generated/client.ts", reason: "generated-or-vendored-content" },
      { included: false, path: "assets/logo.png", reason: "binary-file" },
      { included: false, path: "src/large.ts", reason: "oversized-file" },
      { included: false, path: "src/external.ts", reason: "symlink-outside-source-root" },
      { included: true, path: "src/review.ts" },
    ])
  })

  it("normalizes repository-relative custom exclusions without accepting traversal", () => {
    // Arrange
    const customExcludedCandidate = {
      path: "internal\\restricted/brief.md",
      sizeBytes: 10,
      isBinary: false,
      isSymlink: false,
      resolvesWithinSourceRoot: null,
    }
    const traversalCandidate = {
      ...customExcludedCandidate,
      path: "../.env",
    }

    // Act
    const customExclusion = classifyRepositoryContextFile(
      customExcludedCandidate,
      hardExclusionPolicy
    )
    const traversalExclusion = classifyRepositoryContextFile(
      traversalCandidate,
      hardExclusionPolicy
    )

    // Assert
    expect(customExclusion).toEqual({
      included: false,
      path: "internal/restricted/brief.md",
      reason: "custom-exclusion",
    })
    expect(traversalExclusion).toEqual({ included: false, path: "../.env", reason: "invalid-path" })
  })

  it("accepts only an app-owned read-only head snapshot with the selected Git policy", () => {
    // Arrange
    const hardExclusionRequest = createSnapshotRequest()
    const fullHistoryRequest = createSnapshotRequest({
      includesGitObjectDatabase: true,
      policy: { ...hardExclusionPolicy, mode: "full-git-history" },
    })

    // Act
    const hardExclusionValidation = validateIsolatedSnapshotRequest(hardExclusionRequest)
    const fullHistoryValidation = validateIsolatedSnapshotRequest(fullHistoryRequest)

    // Assert
    expect(hardExclusionValidation).toEqual({ valid: true, policy: hardExclusionPolicy })
    expect(fullHistoryValidation).toEqual({
      valid: true,
      policy: { ...hardExclusionPolicy, mode: "full-git-history" },
    })
  })

  it("rejects snapshot requests that expose the active working tree or weaken source isolation", () => {
    // Arrange
    const unsafeRequest = createSnapshotRequest({
      sourceKind: "user-working-tree" as "app-owned-temporary",
      sourcePath: "/Users/reviewer/src/repo",
      sourceSha: "different-sha",
      sourceReadOnly: false,
      includesGitObjectDatabase: true,
    })

    // Act
    const validation = validateIsolatedSnapshotRequest(unsafeRequest)

    // Assert
    expect(validation).toEqual({
      valid: false,
      errors: [
        "Snapshot source must be app-owned temporary storage",
        "Snapshot source must not be the active working tree",
        "Snapshot source SHA must equal the requested PR head SHA",
        "Snapshot source must be read-only",
        "Hard exclusion snapshots must not include a Git object database",
      ],
    })
  })
})
