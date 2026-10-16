import { describe, expect, it } from "vitest"

import { createFakeGithubGateway } from "../src/services/githubGateway/fakeGateway.js"
import { PR42_COMMIT_SHAS, PR42_PATHS } from "../src/services/githubGateway/fixtures/pr42.js"
import type { PrTarget } from "../src/services/githubGateway/gateway.js"
import { createOctokitGateway } from "../src/services/githubGateway/octokitGateway.js"

// File history at the gateway seam (§10). The Octokit half is driven through an injected fetch,
// because the page cap and the intersection with the PR commit list live at the transport.

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

const headSha = "head999"

const pullPayload = {
  title: "Rate limit login",
  user: { login: "contributor-dev" },
  base: { sha: "base000" },
  head: { sha: headSha },
  body: null,
  html_url: "https://github.com/acme/web/pull/42",
}

function prCommitPayload(sha: string, parentSha: string, headline: string) {
  return {
    sha,
    parents: [{ sha: parentSha }],
    commit: {
      message: headline,
      author: { name: "Contributor Dev", date: "2026-06-28T09:14:00Z" },
    },
    author: { login: "contributor-dev" },
  }
}

// Answers the three endpoints the file history reads. The path listing is served page by page,
// with a `Link: rel="next"` header while `hasNextPage(page)` says so, the way GitHub paginates.
function createHistoryFetch(options: {
  prCommits: unknown[]
  pathPage: (page: number) => Array<{ sha: string }>
  hasNextPage: (page: number) => boolean
}): { fetch: typeof globalThis.fetch; pathPagesRequested: number[] } {
  const pathPagesRequested: number[] = []

  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      })

    if (url.pathname.endsWith("/pulls/42/commits")) return json(options.prCommits)
    if (url.pathname.endsWith("/pulls/42")) return json(pullPayload)

    const page = Number(url.searchParams.get("page") ?? "1")
    pathPagesRequested.push(page)

    const nextUrl = new URL(url)
    nextUrl.searchParams.set("page", String(page + 1))
    const linkHeader: Record<string, string> = options.hasNextPage(page)
      ? { link: `<${nextUrl.toString()}>; rel="next"` }
      : {}

    return json(options.pathPage(page), linkHeader)
  }) as typeof globalThis.fetch

  return { fetch, pathPagesRequested }
}

describe("octokit gateway — listPrCommitsForPath", () => {
  it("lists_only_the_pr_commits_that_touched_the_path_in_pr_order", async () => {
    // Arrange
    const path = "src/lib/rateLimiter.ts"
    const firstSha = "aaaa111"
    const secondSha = "bbbb222"
    const thirdSha = "cccc333"
    const commitOutsideThePr = "0ld0000"
    const prCommits = [
      prCommitPayload(firstSha, "base000", "Add config"),
      prCommitPayload(secondSha, firstSha, "Wire middleware"),
      prCommitPayload(thirdSha, secondSha, "Tune limiter"),
    ]
    // The commits endpoint answers newest-first and walks past the PR into older history.
    const { fetch } = createHistoryFetch({
      prCommits,
      pathPage: () => [{ sha: thirdSha }, { sha: firstSha }, { sha: commitOutsideThePr }],
      hasNextPage: () => false,
    })
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const history = await gateway.listPrCommitsForPath(target, path)

    // Assert
    const expected = { path, shas: [firstSha, thirdSha], truncated: false }
    expect({
      path: history.path,
      shas: history.commits.map((commit) => commit.sha),
      truncated: history.truncated,
    }).toEqual(expected)
  })

  it("flags_truncation_when_the_page_cap_is_hit", async () => {
    // Arrange — every page is full of older commits and always links to another page.
    const path = "src/lib/rateLimiter.ts"
    const prSha = "aaaa111"
    const { fetch, pathPagesRequested } = createHistoryFetch({
      prCommits: [prCommitPayload(prSha, "base000", "Add config")],
      pathPage: (page) => [{ sha: `older-${page}` }],
      hasNextPage: () => true,
    })
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const history = await gateway.listPrCommitsForPath(target, path)

    // Assert — five pages read, then stopped and reported short.
    const expected = { truncated: true, pagesRequested: [1, 2, 3, 4, 5] }
    expect({ truncated: history.truncated, pagesRequested: pathPagesRequested }).toEqual(expected)
  })
})

describe("fake gateway — listPrCommitsForPath", () => {
  it("lists the fixture commits whose files include the path", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const path = PR42_PATHS.rateLimiter

    // Act
    const history = await gateway.listPrCommitsForPath(target, path)

    // Assert
    const expected = { shas: [PR42_COMMIT_SHAS.limiter], hasFilesKey: false }
    expect({
      shas: history.commits.map((commit) => commit.sha),
      hasFilesKey: history.commits.some((commit) => "files" in commit),
    }).toEqual(expected)
  })

  it("returns_no_commits_for_a_path_the_pr_never_touched", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const untouchedPath = "README.md"

    // Act
    const history = await gateway.listPrCommitsForPath(target, untouchedPath)

    // Assert
    const expected = { path: untouchedPath, commits: [], truncated: false }
    expect(history).toEqual(expected)
  })
})
