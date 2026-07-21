import { describe, expect, it } from "vitest"

import type { PrTarget } from "../src/services/githubGateway/gateway.js"
import { createOctokitGateway } from "../src/services/githubGateway/octokitGateway.js"

// The Octokit gateway's GraphQL surface for GitHub's "Viewed" checkbox (§11), asserted at the
// TRANSPORT: an injected fetch records every request, so the query text, the variables and the
// REST/GraphQL split are all verifiable without a network. The shapes asserted here were
// verified 2026-07 against the live GitHub schema by introspection.

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const PULL_NODE_ID = "PR_kwDOABCD12MAAAABcdEfGh"

type RecordedCall = { url: string; body: Record<string, unknown> }

// A fetch that answers the REST `pulls.get` with a node id and every GraphQL POST with
// `graphqlResponse`, recording each call so the test can assert what was sent.
function createRecordingFetch(graphqlResponse: unknown): {
  fetch: typeof globalThis.fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ url, body })

    const payload = url.includes("/graphql")
      ? { data: graphqlResponse }
      : { node_id: PULL_NODE_ID, number: 42 }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch

  return { fetch, calls }
}

describe("octokit gateway viewed state", () => {
  it("reads viewerViewedState off the pullRequest.files connection", async () => {
    // Arrange
    const viewedPath = "src/config/limits.ts"
    const unviewedPath = "src/types/http.ts"
    const { fetch, calls } = createRecordingFetch({
      repository: {
        pullRequest: {
          files: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { path: viewedPath, viewerViewedState: "VIEWED" },
              { path: unviewedPath, viewerViewedState: "UNVIEWED" },
            ],
          },
        },
      },
    })
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const states = await gateway.listViewedFiles(target)

    // Assert — one GraphQL call, carrying the PR coordinates as variables.
    const expectedStates = { [viewedPath]: "VIEWED", [unviewedPath]: "UNVIEWED" }
    const expectedVariables = { owner: "acme", repo: "webapp", number: 42, after: null }
    expect(states).toEqual(expectedStates)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain("/graphql")
    expect(calls[0]!.body.variables).toEqual(expectedVariables)
    expect(String(calls[0]!.body.query)).toContain("viewerViewedState")
  })

  it("sends markFileAsViewed with the PR node id when marking a file viewed", async () => {
    // Arrange
    const path = "src/config/limits.ts"
    const { fetch, calls } = createRecordingFetch({ markFileAsViewed: { clientMutationId: null } })
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    await gateway.setFileViewed(target, path, true)

    // Assert
    const graphqlCalls = calls.filter((call) => call.url.includes("/graphql"))
    const expectedVariables = { pullRequestId: PULL_NODE_ID, path }
    expect(graphqlCalls).toHaveLength(1)
    expect(String(graphqlCalls[0]!.body.query)).toContain("markFileAsViewed")
    expect(graphqlCalls[0]!.body.variables).toEqual(expectedVariables)
  })

  it("sends unmarkFileAsViewed when un-marking, and reuses the cached PR node id", async () => {
    // Arrange
    const path = "src/config/limits.ts"
    const { fetch, calls } = createRecordingFetch({
      unmarkFileAsViewed: { clientMutationId: null },
    })
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act — two writes in a row; the node id must be resolved only once.
    await gateway.setFileViewed(target, path, false)
    await gateway.setFileViewed(target, path, false)

    // Assert
    const restCalls = calls.filter((call) => !call.url.includes("/graphql"))
    const graphqlCalls = calls.filter((call) => call.url.includes("/graphql"))
    expect(String(graphqlCalls[0]!.body.query)).toContain("unmarkFileAsViewed")
    expect(graphqlCalls).toHaveLength(2)
    expect(restCalls).toHaveLength(1)
  })

  it("walks the files connection to the last page", async () => {
    // Arrange — a two-page connection; stopping early would report page 2 as unviewed.
    const firstPagePath = "src/config/limits.ts"
    const secondPagePath = "src/types/http.ts"
    let page = 0
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (!url.includes("/graphql")) {
        return new Response(JSON.stringify({ node_id: PULL_NODE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      page += 1
      const isFirst = page === 1
      const data = {
        repository: {
          pullRequest: {
            files: {
              pageInfo: { hasNextPage: isFirst, endCursor: isFirst ? "cursor-1" : null },
              nodes: [
                {
                  path: isFirst ? firstPagePath : secondPagePath,
                  viewerViewedState: "VIEWED",
                },
              ],
            },
          },
        },
      }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const states = await gateway.listViewedFiles(target)

    // Assert
    const expected = { [firstPagePath]: "VIEWED", [secondPagePath]: "VIEWED" }
    expect(states).toEqual(expected)
  })
})
