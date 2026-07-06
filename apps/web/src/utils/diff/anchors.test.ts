import { describe, expect, it } from "vitest"

import { pr42Analysis, pr42Paths } from "@/service/fixture/pr42"

import { anchorsForLine, buildAnchorIndex } from "./anchors"

// Symbol anchors overlay the diff (§10): an identifier underlines ONLY when its
// counterpart exists in the PR. Mapping occurrences -> (path, head line) is pure.

describe("buildAnchorIndex — occurrences to diff lines (§10)", () => {
  it("underlines a usage that has a definition in the PR", () => {
    // Arrange
    const symbolId = `${pr42Paths.rateLimiter}#createRateLimiter`
    const usageLine = 5 // `const limiter = createRateLimiter(LOGIN_RATE_LIMIT);`

    // Act
    const index = buildAnchorIndex(pr42Analysis.occurrences, pr42Analysis.symbols)
    const anchors = anchorsForLine(index, pr42Paths.withRateLimit, usageLine)
    const createRateLimiter = anchors.find((anchor) => anchor.symbolId === symbolId)

    // Assert
    expect(createRateLimiter).toBeDefined()
    expect(createRateLimiter!.role).toBe("usage")
    expect(createRateLimiter!.hasCounterpart).toBe(true)
    expect(createRateLimiter!.definition).toEqual({ path: pr42Paths.rateLimiter, line: 3 })
  })

  it("gives a definition the full list of its usages for the N-usages pill", () => {
    // Arrange
    const symbolId = `${pr42Paths.rateLimiter}#createRateLimiter`
    const definitionLine = 3

    // Act
    const index = buildAnchorIndex(pr42Analysis.occurrences, pr42Analysis.symbols)
    const anchors = anchorsForLine(index, pr42Paths.rateLimiter, definitionLine)
    const definition = anchors.find(
      (anchor) => anchor.symbolId === symbolId && anchor.role === "definition"
    )

    // Assert
    expect(definition).toBeDefined()
    expect(definition!.hasCounterpart).toBe(true)
    expect(definition!.usages).toEqual([
      { path: pr42Paths.withRateLimit, line: 1 },
      { path: pr42Paths.withRateLimit, line: 5 },
      { path: pr42Paths.test, line: 1 },
      { path: pr42Paths.test, line: 5 },
    ])
  })

  it("does not underline a definition with no usages (never dead-ends)", () => {
    // Arrange — loginHandler is defined but used nowhere in the PR.
    const symbolId = `${pr42Paths.login}#loginHandler`
    const definitionLine = 4

    // Act
    const index = buildAnchorIndex(pr42Analysis.occurrences, pr42Analysis.symbols)
    const anchors = anchorsForLine(index, pr42Paths.login, definitionLine)
    const loginHandler = anchors.find((anchor) => anchor.symbolId === symbolId)

    // Assert
    expect(loginHandler!.hasCounterpart).toBe(false)
    expect(loginHandler!.usages).toEqual([])
  })

  it("returns no anchors for a line with no symbol occurrences", () => {
    // Arrange
    const emptyLine = 4 // a blank added line in withRateLimit.ts

    // Act
    const index = buildAnchorIndex(pr42Analysis.occurrences, pr42Analysis.symbols)
    const anchors = anchorsForLine(index, pr42Paths.withRateLimit, emptyLine)

    // Assert
    expect(anchors).toEqual([])
  })
})
