import { describe, expect, it } from "vitest"

import { createFakeGithubGateway } from "../src/services/githubGateway/fakeGateway.js"
import { PR42_META } from "../src/services/githubGateway/fixtures/pr42.js"
import type { PrTarget } from "../src/services/githubGateway/gateway.js"
import { createOctokitGateway } from "../src/services/githubGateway/octokitGateway.js"

// The description viewer reads `body` + `htmlUrl` off PrMeta. Two seams must carry them: the
// fake gateway (used by every fixture/server test) round-trips the fixture's values, and the
// real octokit gateway maps GitHub's `pulls.get` `body`/`html_url` onto the contract.

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

describe("getPullMeta description fields", () => {
  it("round-trips body and htmlUrl through the fake gateway", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const expectedBody = PR42_META.body
    const expectedUrl = PR42_META.htmlUrl

    // Act
    const meta = await gateway.getPullMeta(target)

    // Assert
    expect(meta.body).toBe(expectedBody)
    expect(meta.htmlUrl).toBe(expectedUrl)
  })

  it("maps GitHub pulls.get body and html_url onto PrMeta", async () => {
    // Arrange — a stub transport answering pulls.get with the two fields the viewer needs.
    const body = "## Summary\n\nrate limiting"
    const htmlUrl = "https://github.com/acme/web/pull/42"
    const pullsGetPayload = {
      title: "Add login rate limiting",
      user: { login: "octocat" },
      base: { sha: "base0000" },
      head: { sha: "head1111" },
      body,
      html_url: htmlUrl,
    }
    const fetch = (async () =>
      new Response(JSON.stringify(pullsGetPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const meta = await gateway.getPullMeta(target)

    // Assert
    expect(meta.body).toBe(body)
    expect(meta.htmlUrl).toBe(htmlUrl)
  })

  it("maps a null GitHub body to null (no description)", async () => {
    // Arrange
    const nullBody = null
    const pullsGetPayload = {
      title: "Docs tweak",
      user: { login: "octocat" },
      base: { sha: "base0000" },
      head: { sha: "head2222" },
      body: nullBody,
      html_url: "https://github.com/acme/web/pull/42",
    }
    const fetch = (async () =>
      new Response(JSON.stringify(pullsGetPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch
    const gateway = createOctokitGateway("test-token", { fetch })

    // Act
    const meta = await gateway.getPullMeta(target)

    // Assert
    expect(meta.body).toBeNull()
  })
})
