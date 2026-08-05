// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { createHttpPrClient } from "./httpPrClient"

// The refresh command is the app's only BODYLESS write. Declaring `content-type:
// application/json` on it makes Fastify reject the empty body with 400 before the route runs —
// a browser-only failure (curl sends no content-type, so it never reproduces). These tests pin
// the request shape, because the 400 is invisible from the app: the mutation just does nothing.

const PR42: PrTarget = { owner: "acme", repo: "web", number: 42 }

function captureFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })

    return Promise.resolve(new Response(null, { status }))
  })
  vi.stubGlobal("fetch", fetchMock)

  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("createHttpPrClient — invalidatePr", () => {
  it("posts the refresh command with no JSON content-type, since it sends no body", async () => {
    // Arrange
    const noContent = 204
    const calls = captureFetch(noContent)

    // Act
    await createHttpPrClient().invalidatePr(PR42)

    // Assert
    const expected = {
      url: "/api/prs/acme/web/42/refresh",
      method: "POST",
      contentType: undefined,
    }
    const [call] = calls
    expect({
      url: call?.url,
      method: call?.init?.method,
      contentType: new Headers(call?.init?.headers).get("content-type") ?? undefined,
    }).toEqual(expected)
  })

  it("throws on a rejected refresh instead of reporting a silent success", async () => {
    // Arrange
    const badRequest = 400
    captureFetch(badRequest)

    // Act / Assert
    await expect(createHttpPrClient().invalidatePr(PR42)).rejects.toThrow(/400/)
  })
})
