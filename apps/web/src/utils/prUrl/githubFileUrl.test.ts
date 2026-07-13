// @vitest-environment node
//
// Runs under node so globalThis.crypto.subtle is the real WebCrypto (jsdom omits it). The
// anchor scheme is the verified one — SHA-256 of the exact path, no trailing newline — so this
// test doubles as an executable record of it: sha256("src/index.js") === bfe9874d…820556
// (GitHub community discussion #43908).
import { describe, expect, it } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { githubPrFileUrl } from "./githubFileUrl"

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

describe("githubPrFileUrl", () => {
  it("builds the files-tab URL with the verified sha256(path) anchor", async () => {
    // Arrange
    const path = "src/index.js"

    // Act
    const url = await githubPrFileUrl(target, path)

    // Assert
    const expected =
      "https://github.com/acme/web/pull/42/files#diff-bfe9874d239014961b1ae4e89875a6155667db834a410aaaa2ebe3cf89820556"
    expect(url).toBe(expected)
  })
})
