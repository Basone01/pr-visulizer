// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import {
  MAX_CODEX_SAFE_PROFILE_PATCH_RESPONSE_BYTES,
  assembleBoundedRevisionPinnedPatches,
} from "@/service/aiReview/codexReviewContext"

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

describe("createHttpPrClient — bounded patch reads", () => {
  it("ai_context_omits_over_limit_api_patch_bytes_before_json_materialization", async () => {
    // Arrange — the AI seam over the real HTTP client: the overview route answers the two identity
    // reads, and the requested file's RESPONSE exceeds the cap while the patch string it encodes
    // would not. Only a guard that measures response bytes before decoding can reject this; a
    // guard placed after JSON parsing would admit the patch and disclose it as reviewed.
    const baseSha = "base-sha"
    const headSha = "head-sha"
    const overLimitPath = "src/oversized.ts"
    const overview = {
      pr: {
        owner: PR42.owner,
        repo: PR42.repo,
        number: PR42.number,
        title: "Bounded patch reads",
        author: "reviewer",
        baseSha,
        headSha,
      },
      files: [],
    }
    // Every newline costs two JSON bytes, so the encoded body is twice the decoded patch.
    const patchBody = JSON.stringify({ patch: "\n".repeat(90 * 1024) })
    const responseBytes = new TextEncoder().encode(patchBody).byteLength
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("/files/")
            ? new Response(patchBody, {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "content-length": String(responseBytes),
                },
              })
            : new Response(JSON.stringify(overview), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
        )
      )
    )

    // Act
    const assembly = await assembleBoundedRevisionPinnedPatches({
      baseSha,
      headSha,
      paths: [overLimitPath],
      maxResponseBytes: MAX_CODEX_SAFE_PROFILE_PATCH_RESPONSE_BYTES,
      loadSnapshot: (paths) =>
        createHttpPrClient().getRevisionPinnedPatchSnapshot(PR42, { baseSha, headSha, paths }),
    })

    // Assert — the path is disclosed as a byte-limit omission, and no patch string was retained.
    const expected = {
      responseOverCap: true,
      decodedPatchWithinAssemblerCap: true,
      assembly: {
        baseSha,
        headSha,
        patches: {},
        omissions: [{ path: overLimitPath, reason: "patch-byte-limit" }],
      },
    }
    expect({
      responseOverCap: responseBytes > MAX_CODEX_SAFE_PROFILE_PATCH_RESPONSE_BYTES,
      decodedPatchWithinAssemblerCap: 90 * 1024 <= MAX_CODEX_SAFE_PROFILE_PATCH_RESPONSE_BYTES,
      assembly,
    }).toEqual(expected)
  })

  it("api_patch_response_exceeding_byte_cap_is_rejected_before_patch_parsing", async () => {
    // Arrange
    const oversizedPatch = "x".repeat(128 * 1024)
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ patch: oversizedPatch }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      )
    )

    // Act
    const patch = createHttpPrClient().getPatch(PR42, "src/oversized.ts")

    // Assert — the API body is omitted before it can become a patch string in the client.
    await expect(patch).rejects.toThrow("API patch exceeded the bounded patch byte limit")
  })
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
