import { describe, expect, it } from "vitest"

import { createFakeGithubGateway } from "../src/services/githubGateway/fakeGateway.js"
import type { PrTarget } from "../src/services/githubGateway/gateway.js"
import { createOctokitGateway } from "../src/services/githubGateway/octokitGateway.js"

// The gateway's "list existing review comments" surface (GET /pulls/:n/comments), asserted on
// both sides: the fake round-trips its fixture threads, and the Octokit impl is checked at the
// TRANSPORT — an injected fetch records the REST calls so pagination and field mapping are
// verifiable without a network. Endpoint + fields verified 2026-07-23 against
// docs.github.com/en/rest/pulls/comments.

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

describe("fake gateway listReviewComments", () => {
  it("returns the fixture threads, keeping reply and outdated shapes intact", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()

    // Act
    const comments = await gateway.listReviewComments(target)

    // Assert — the reply chains to its root, and the outdated comment carries a null line.
    const reply = comments.find((comment) => comment.inReplyToId !== null)
    const outdated = comments.find((comment) => comment.line === null)
    expect(comments.length).toBeGreaterThanOrEqual(3)
    expect(reply?.inReplyToId).toBe(5001)
    expect(outdated?.id).toBe(5003)
  })

  it("answers an unknown PR with an empty list rather than throwing", async () => {
    // Arrange — a fixture with no reviewComments field is a PR nobody commented on.
    const bareTarget: PrTarget = { owner: "acme", repo: "web", number: 42 }
    const gateway = createFakeGithubGateway([
      {
        meta: { ...(await createFakeGithubGateway().getPullMeta(bareTarget)) },
        files: [],
        contents: {},
      },
    ])

    // Act
    const comments = await gateway.listReviewComments(bareTarget)

    // Assert
    const expected = 0
    expect(comments).toHaveLength(expected)
  })
})

type RecordedCall = { url: string }

// A fetch that serves TWO pages of review comments (page 1 full at per_page=100, page 2 the
// remainder) so octokit.paginate has to follow the Link header — proving the gateway drains
// every page instead of stopping at the first.
function createPagingFetch(): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []

  const firstPage = Array.from({ length: 100 }, (_unused, index) => ({
    id: index + 1,
    path: "src/lib/rateLimiter.ts",
    line: 3,
    start_line: null,
    side: "RIGHT",
    in_reply_to_id: null,
    user: { login: "reviewer" },
    body: `comment ${index + 1}`,
    created_at: "2026-07-20T09:00:00Z",
  }))
  const secondPage = [
    {
      id: 101,
      path: "src/lib/rateLimiter.ts",
      line: null,
      start_line: null,
      side: "LEFT",
      in_reply_to_id: 1,
      user: null,
      body: "the last one",
      created_at: "2026-07-20T10:00:00Z",
    },
  ]

  const fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push({ url })

    const isSecondPage = url.includes("page=2")
    const body = isSecondPage ? secondPage : firstPage
    // A `rel="next"` Link on page 1 is what makes octokit.paginate request page 2.
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (!isSecondPage) {
      headers.link = `<https://api.github.com/repositories/1/pulls/42/comments?per_page=100&page=2>; rel="next"`
    }

    return new Response(JSON.stringify(body), { status: 200, headers })
  }) as typeof globalThis.fetch

  return { fetch, calls }
}

describe("octokit gateway listReviewComments", () => {
  it("paginates every page and maps snake_case rows to the shared shape", async () => {
    // Arrange
    const { fetch, calls } = createPagingFetch()
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const comments = await gateway.listReviewComments(target)

    // Assert — both pages drained (101 rows), the request hit the comments endpoint at
    // per_page=100, and the mapping carried null line + the reply id + the null-author fallback.
    const expectedCount = 101
    const last = comments[comments.length - 1]!
    expect(comments).toHaveLength(expectedCount)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]!.url).toContain("/pulls/42/comments")
    expect(calls[0]!.url).toContain("per_page=100")
    expect(last.line).toBeNull()
    expect(last.inReplyToId).toBe(1)
    expect(last.side).toBe("LEFT")
    expect(last.author).toBe("ghost")
  })
})
