import { describe, expect, it } from "vitest"

import { parseOriginUrl } from "./parseOriginUrl"

describe("parseOriginUrl", () => {
  it.each([
    ["git@github.com:acme/web.git", { owner: "acme", repo: "web" }],
    ["git@github.com:acme/web", { owner: "acme", repo: "web" }],
    ["ssh://git@github.com/acme/web.git", { owner: "acme", repo: "web" }],
    ["https://github.com/acme/web.git", { owner: "acme", repo: "web" }],
    ["https://github.com/acme/web", { owner: "acme", repo: "web" }],
    ["https://github.com/acme/web/", { owner: "acme", repo: "web" }],
    ["  https://github.com/acme/my-repo.name.git \n", { owner: "acme", repo: "my-repo.name" }],
  ])("parses %s", (originUrl, expected) => {
    // Act
    const actual = parseOriginUrl(originUrl)

    // Assert
    expect(actual).toEqual(expected)
  })

  it.each([
    ["https://gitlab.com/acme/web.git"], // not GitHub
    ["git@github.com:acme"], // no repo segment
    ["/Users/dev/some/folder"], // a bare path, not a remote
    [""],
  ])("returns null for %s", (originUrl) => {
    // Act
    const actual = parseOriginUrl(originUrl)

    // Assert
    expect(actual).toBeNull()
  })
})
