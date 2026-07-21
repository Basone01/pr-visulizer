import { commitRange } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { createFakeGithubGateway } from "../src/services/githubGateway/fakeGateway.js"
import {
  PR42_COMMIT_SHAS,
  PR42_META,
  PR42_PATHS,
} from "../src/services/githubGateway/fixtures/pr42.js"
import type { PrTarget } from "../src/services/githubGateway/gateway.js"
import { createOctokitGateway } from "../src/services/githubGateway/octokitGateway.js"

// Commit-range selection at the gateway seam (§10). The Octokit half is asserted at the
// TRANSPORT — an injected fetch records the URL — because the one thing that must not be wrong
// is the REF PAIR we compare: the base is the first selected commit's first parent, and the
// separator is three dots. Both were verified 2026-07 against docs.github.com
// (rest/commits/commits#compare-two-commits, rest/pulls/pulls#list-commits-on-a-pull-request).

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

type RecordedCall = { method: string; url: string }

// A fetch that answers the two commit-range endpoints with fixed payloads and records every
// request line, so a test can assert exactly which refs were asked for.
function createRecordingFetch(payloadByUrlPart: Array<[string, unknown]>): {
  fetch: typeof globalThis.fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ method: init?.method ?? "GET", url })

    const match = payloadByUrlPart.find(([part]) => url.includes(part))

    return new Response(JSON.stringify(match ? match[1] : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch

  return { fetch, calls }
}

describe("octokit gateway — listPrCommits", () => {
  it("maps the commits payload onto the contract, keeping every parent sha", async () => {
    // Arrange
    const firstSha = "aaaa111"
    const parentSha = "base000"
    const commitsPayload = [
      {
        sha: firstSha,
        parents: [{ sha: parentSha }],
        commit: {
          message: "Add rate-limit config\n\nA body the picker must not show.",
          author: { name: "Contributor Dev", date: "2026-06-28T09:14:00Z" },
        },
        author: { login: "contributor-dev" },
      },
    ]
    const { fetch, calls } = createRecordingFetch([["/pulls/42/commits", commitsPayload]])
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const list = await gateway.listPrCommits(target)

    // Assert — the headline is the message's FIRST LINE only, and parents survive the mapping.
    const expected = {
      sha: firstSha,
      parents: [parentSha],
      messageHeadline: "Add rate-limit config",
      author: "contributor-dev",
      authoredAt: "2026-06-28T09:14:00Z",
      truncated: false,
    }
    expect({ ...list.commits[0], truncated: list.truncated }).toEqual(expected)
    expect(calls[0]?.url).toContain("/repos/acme/web/pulls/42/commits")
  })

  it("falls back to the git author name when the commit has no GitHub account", async () => {
    // Arrange
    const commitsPayload = [
      {
        sha: "bbbb222",
        parents: [{ sha: "aaaa111" }],
        commit: {
          message: "Fix a typo",
          author: { name: "Unlinked Author", date: "2026-06-29T10:00:00Z" },
        },
        author: null,
      },
    ]
    const { fetch } = createRecordingFetch([["/pulls/42/commits", commitsPayload]])
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const list = await gateway.listPrCommits(target)

    // Assert
    const expected = "Unlinked Author"
    expect(list.commits[0]?.author).toEqual(expected)
  })
})

describe("octokit gateway — compareRange", () => {
  it("compares parent-of-first-commit...last-commit with a THREE-dot basehead", async () => {
    // Arrange — the range base is the first selected commit's first parent, never `sha^`.
    const parentOfFirstSelected = "base000aaa"
    const firstSelectedSha = "aaaa111bbb"
    const lastSelectedSha = "cccc333ddd"
    const comparePayload = {
      files: [
        {
          filename: "src/config/limits.ts",
          status: "added",
          additions: 4,
          deletions: 0,
          patch: "@@ -0,0 +1,1 @@\n+export const X = 1",
        },
      ],
    }
    const { fetch, calls } = createRecordingFetch([["/compare/", comparePayload]])
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const diff = await gateway.compareRange(target, parentOfFirstSelected, lastSelectedSha)

    // Assert — the ref pair is what this test exists for.
    const expectedBasehead = `${parentOfFirstSelected}...${lastSelectedSha}`
    expect(calls[0]?.url).toContain(`/repos/acme/web/compare/${expectedBasehead}`)
    // No git rev syntax may reach the URL — `^` is undocumented for this endpoint.
    expect(calls[0]?.url).not.toContain("%5E")
    expect(calls[0]?.url).not.toContain("^")
    expect(firstSelectedSha).not.toEqual(parentOfFirstSelected)

    const expectedFile = {
      path: "src/config/limits.ts",
      status: "added",
      additions: 4,
      deletions: 0,
      previousPath: null,
    }
    expect({
      path: diff.files[0]?.path,
      status: diff.files[0]?.status,
      additions: diff.files[0]?.additions,
      deletions: diff.files[0]?.deletions,
      previousPath: diff.files[0]?.previousPath,
    }).toEqual(expectedFile)
  })

  it("carries a renamed file's previous path through from previous_filename", async () => {
    // Arrange
    const comparePayload = {
      files: [
        {
          filename: "src/lib/rateLimiter.ts",
          status: "renamed",
          additions: 2,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n context\n+added",
          previous_filename: "src/lib/limiter.ts",
        },
      ],
    }
    const { fetch } = createRecordingFetch([["/compare/", comparePayload]])
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const diff = await gateway.compareRange(target, "base000", "head999")

    // Assert
    const expected = { path: "src/lib/rateLimiter.ts", previousPath: "src/lib/limiter.ts" }
    expect({ path: diff.files[0]?.path, previousPath: diff.files[0]?.previousPath }).toEqual(
      expected
    )
  })

  it("reports a binary/omitted diff as a null patch rather than an empty string", async () => {
    // Arrange
    const comparePayload = {
      files: [{ filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0 }],
    }
    const { fetch } = createRecordingFetch([["/compare/", comparePayload]])
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const diff = await gateway.compareRange(target, "base000", "head999")

    // Assert
    const expected = null
    expect(diff.files[0]?.patch).toEqual(expected)
  })
})

describe("fake gateway — commit range round trip", () => {
  it("lists the fixture's commits without leaking its per-commit file slices", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()

    // Act
    const list = await gateway.listPrCommits(target)

    // Assert — the contract has no `files` on a commit; the fake must not smuggle one through.
    const expected = {
      shas: [PR42_COMMIT_SHAS.config, PR42_COMMIT_SHAS.limiter, PR42_COMMIT_SHAS.wiring],
      truncated: false,
      hasFilesKey: false,
    }
    expect({
      shas: list.commits.map((commit) => commit.sha),
      truncated: list.truncated,
      hasFilesKey: list.commits.some((commit) => "files" in commit),
    }).toEqual(expected)
  })

  it("restricts a single-commit range to just that commit's files", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const { commits } = await gateway.listPrCommits(target)
    const limiterCommit = commits[1]
    if (!limiterCommit) throw new Error("fixture must have a second commit")

    const range = commitRange(limiterCommit, limiterCommit, PR42_META.baseSha)

    // Act
    const diff = await gateway.compareRange(target, range.baseSha, range.headSha)

    // Assert
    const expected = {
      baseSha: PR42_COMMIT_SHAS.config,
      paths: [PR42_PATHS.rateLimiter, PR42_PATHS.test],
    }
    expect({
      baseSha: diff.baseSha,
      paths: diff.files.map((file) => file.path).sort(),
    }).toEqual({ ...expected, paths: expected.paths.sort() })
  })

  it("unions the files of every commit in a multi-commit range", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const { commits } = await gateway.listPrCommits(target)
    const firstCommit = commits[0]
    const lastCommit = commits[2]
    if (!firstCommit || !lastCommit) throw new Error("fixture must have three commits")

    const range = commitRange(firstCommit, lastCommit, PR42_META.baseSha)

    // Act
    const diff = await gateway.compareRange(target, range.baseSha, range.headSha)

    // Assert — the whole PR: base...last commit covers all six files.
    const expected = { baseSha: PR42_META.baseSha, fileCount: 6 }
    expect({ baseSha: diff.baseSha, fileCount: diff.files.length }).toEqual(expected)
  })

  it("answers an unknown range with no files instead of a wrong slice", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const unknownBaseSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

    // Act
    const diff = await gateway.compareRange(target, unknownBaseSha, PR42_COMMIT_SHAS.wiring)

    // Assert
    const expected = 0
    expect(diff.files.length).toEqual(expected)
  })
})
