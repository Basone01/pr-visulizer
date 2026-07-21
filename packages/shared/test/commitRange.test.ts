import { describe, expect, it } from "vitest"

import {
  type PrCommit,
  type RangeDiff,
  commitRange,
  prCommitListSchema,
  rangeDiffSchema,
  rangeFileFor,
  rangeTouchedPaths,
  shortSha,
} from "../src/index.js"

// The commit-range contract (docs/architecture.md §10). The range BASE is the first parent of
// the first selected commit — the mechanism verified against the GitHub docs — so these tests
// pin that derivation, not just the schema shapes.

const commitA: PrCommit = {
  sha: "aaaaaaa1111111111111111111111111111aaaa",
  parents: ["base000000000000000000000000000000base"],
  messageHeadline: "add rate limit config",
  author: "octocat",
  authoredAt: "2026-07-01T10:00:00Z",
}

const commitB: PrCommit = {
  sha: "bbbbbbb2222222222222222222222222222bbbb",
  parents: [commitA.sha],
  messageHeadline: "add the limiter itself",
  author: "octocat",
  authoredAt: "2026-07-01T11:00:00Z",
}

const commitC: PrCommit = {
  sha: "ccccccc3333333333333333333333333333cccc",
  parents: [commitB.sha],
  messageHeadline: "wire the middleware",
  author: "octocat",
  authoredAt: "2026-07-01T12:00:00Z",
}

describe("commitRange", () => {
  it("bases a single-commit range on that commit's first parent", () => {
    // Arrange
    const first = commitB
    const last = commitB
    const fallbackBaseSha = "prbase00000000000000000000000000000base"

    // Act
    const range = commitRange(first, last, fallbackBaseSha)

    // Assert
    const expected = { baseSha: commitA.sha, headSha: commitB.sha }
    expect(range).toEqual(expected)
  })

  it("spans a multi-commit range from the first commit's parent to the last commit", () => {
    // Arrange
    const first = commitA
    const last = commitC
    const fallbackBaseSha = "prbase00000000000000000000000000000base"

    // Act
    const range = commitRange(first, last, fallbackBaseSha)

    // Assert
    const expected = { baseSha: commitA.parents[0], headSha: commitC.sha }
    expect(range).toEqual(expected)
  })

  it("falls back to the PR base when the first commit is a root commit with no parents", () => {
    // Arrange
    const rootCommit: PrCommit = { ...commitA, parents: [] }
    const fallbackBaseSha = "prbase00000000000000000000000000000base"

    // Act
    const range = commitRange(rootCommit, rootCommit, fallbackBaseSha)

    // Assert
    const expected = { baseSha: fallbackBaseSha, headSha: rootCommit.sha }
    expect(range).toEqual(expected)
  })

  it("takes the FIRST parent of a merge commit, not the merged-in branch", () => {
    // Arrange
    const mainlineParentSha = commitB.sha
    const mergedInParentSha = "ffffffff44444444444444444444444444ffff"
    const mergeCommit: PrCommit = {
      ...commitC,
      parents: [mainlineParentSha, mergedInParentSha],
    }
    const fallbackBaseSha = "prbase00000000000000000000000000000base"

    // Act
    const range = commitRange(mergeCommit, mergeCommit, fallbackBaseSha)

    // Assert
    const expected = { baseSha: mainlineParentSha, headSha: mergeCommit.sha }
    expect(range).toEqual(expected)
  })
})

describe("rangeFileFor", () => {
  const renamedDiff: RangeDiff = {
    baseSha: commitA.parents[0] ?? "",
    headSha: commitC.sha,
    files: [
      {
        path: "src/lib/rateLimiter.ts",
        status: "renamed",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n context\n+added",
        previousPath: "src/lib/limiter.ts",
      },
      {
        path: "src/config/limits.ts",
        status: "added",
        additions: 4,
        deletions: 0,
        patch: "@@ -0,0 +1,4 @@\n+export const X = 1",
        previousPath: null,
      },
    ],
    truncated: false,
  }

  it("finds a file by its current path", () => {
    // Arrange
    const path = "src/config/limits.ts"

    // Act
    const found = rangeFileFor(renamedDiff, path)

    // Assert
    const expected = { path: "src/config/limits.ts", status: "added" }
    expect({ path: found?.path, status: found?.status }).toEqual(expected)
  })

  it("finds a renamed file by the path it had BEFORE the range", () => {
    // Arrange
    const preRenamePath = "src/lib/limiter.ts"

    // Act
    const found = rangeFileFor(renamedDiff, preRenamePath)

    // Assert
    const expected = { path: "src/lib/rateLimiter.ts", previousPath: "src/lib/limiter.ts" }
    expect({ path: found?.path, previousPath: found?.previousPath }).toEqual(expected)
  })

  it("returns null for a file the range never touched", () => {
    // Arrange
    const untouchedPath = "src/api/routes/login.ts"

    // Act
    const found = rangeFileFor(renamedDiff, untouchedPath)

    // Assert
    const expected = null
    expect(found).toEqual(expected)
  })

  it("collects touched paths under both their current and pre-rename names", () => {
    // Arrange
    const diff = renamedDiff

    // Act
    const touched = rangeTouchedPaths(diff)

    // Assert
    const expected = ["src/config/limits.ts", "src/lib/limiter.ts", "src/lib/rateLimiter.ts"]
    expect([...touched].sort()).toEqual(expected)
  })
})

describe("commit-range schemas", () => {
  it("parses a commit list carrying the truncation flag", () => {
    // Arrange
    const payload = {
      commits: [commitA, commitB],
      truncated: true,
    }

    // Act
    const parsed = prCommitListSchema.parse(payload)

    // Assert
    const expected = { count: 2, truncated: true, firstParent: commitA.parents[0] }
    expect({
      count: parsed.commits.length,
      truncated: parsed.truncated,
      firstParent: parsed.commits[0]?.parents[0],
    }).toEqual(expected)
  })

  it("rejects a range diff whose file status is outside the contract", () => {
    // Arrange
    const unsupportedStatus = {
      baseSha: commitA.sha,
      headSha: commitC.sha,
      files: [
        {
          path: "src/x.ts",
          status: "copied",
          additions: 1,
          deletions: 0,
          patch: null,
          previousPath: null,
        },
      ],
      truncated: false,
    }

    // Act
    const result = rangeDiffSchema.safeParse(unsupportedStatus)

    // Assert
    const expected = false
    expect(result.success).toEqual(expected)
  })

  it("shortens a sha to GitHub's seven-character form", () => {
    // Arrange
    const sha = commitA.sha

    // Act
    const short = shortSha(sha)

    // Assert
    const expected = "aaaaaaa"
    expect(short).toEqual(expected)
  })
})
