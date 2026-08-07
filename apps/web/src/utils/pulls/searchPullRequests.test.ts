import type { PrSummary } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { RECENT_PULLS_LIMIT, matchesPullQuery, visiblePullRequests } from "./searchPullRequests"

// The home card shows a few recent PRs, and a search reaches past that cap. Both rules live in
// this pure function, so the card never has to decide what "recent" means.

function pull(overrides: Partial<PrSummary> & { number: number }): PrSummary {
  return {
    number: overrides.number,
    title: overrides.title ?? "Add login rate limiting",
    author: overrides.author ?? "octocat",
    updatedAt: overrides.updatedAt ?? "2026-07-01T12:00:00.000Z",
  }
}

// Seven PRs, oldest first on purpose — the function has to sort, not trust the input order.
const SEVEN_PULLS: PrSummary[] = [
  pull({ number: 11, title: "Bump deps", updatedAt: "2026-06-01T09:00:00.000Z" }),
  pull({ number: 12, title: "Fix flaky login test", updatedAt: "2026-06-02T09:00:00.000Z" }),
  pull({ number: 13, title: "Add rate limit metrics", updatedAt: "2026-06-03T09:00:00.000Z" }),
  pull({ number: 42, title: "Add login rate limiting", updatedAt: "2026-06-04T09:00:00.000Z" }),
  pull({ number: 47, title: "Retry on 429", updatedAt: "2026-06-05T09:00:00.000Z" }),
  pull({ number: 51, title: "Docs: rate limits", updatedAt: "2026-06-06T09:00:00.000Z" }),
  pull({ number: 52, title: "Drop dead code", updatedAt: "2026-06-07T09:00:00.000Z" }),
]

describe("visiblePullRequests", () => {
  it("shows only the most recent few when nothing is searched", () => {
    // Arrange
    const noQuery = ""

    // Act
    const visible = visiblePullRequests(SEVEN_PULLS, noQuery)

    // Assert — newest first, capped, so the two oldest never reach the card.
    const expected = [52, 51, 47, 42, 13]
    expect(visible.map((found) => found.number)).toEqual(expected)
    expect(visible).toHaveLength(RECENT_PULLS_LIMIT)
  })

  it("reaches past the cap for a match the cap had hidden", () => {
    // Arrange — #11 is the oldest of the seven, so an unsearched card never shows it.
    const query = "Bump"

    // Act
    const visible = visiblePullRequests(SEVEN_PULLS, query)

    // Assert
    const expected = [11]
    expect(visible.map((found) => found.number)).toEqual(expected)
  })

  it("keeps every match, even when a search matches more than the cap", () => {
    // Arrange — "rate" appears in three titles; a search must not re-apply the limit.
    const query = "rate"
    const manyMatches = [...SEVEN_PULLS, pull({ number: 60, title: "rate limiter v2" })]

    // Act
    const visible = visiblePullRequests(manyMatches, query, 2)

    // Assert
    const expectedCount = 4
    expect(visible).toHaveLength(expectedCount)
  })

  it("orders results newest-updated first regardless of input order", () => {
    // Arrange
    const noQuery = ""
    const oldestFirst = SEVEN_PULLS

    // Act
    const visible = visiblePullRequests(oldestFirst, noQuery)

    // Assert
    const expectedNewest = 52
    expect(visible[0]!.number).toBe(expectedNewest)
  })
})

describe("matchesPullQuery", () => {
  it("matches a title case-insensitively, anywhere in it", () => {
    // Arrange
    const target = pull({ number: 42, title: "Add login rate limiting" })
    const query = "LOGIN RATE"

    // Act
    const matched = matchesPullQuery(target, query)

    // Assert
    expect(matched).toBe(true)
  })

  it("matches a number by prefix, so a half-typed number already finds it", () => {
    // Arrange
    const target = pull({ number: 42 })
    const halfTyped = "4"

    // Act
    const matched = matchesPullQuery(target, halfTyped)

    // Assert
    expect(matched).toBe(true)
  })

  it("accepts the # people actually type in front of a PR number", () => {
    // Arrange
    const target = pull({ number: 42 })
    const query = "#42"

    // Act
    const matched = matchesPullQuery(target, query)

    // Assert
    expect(matched).toBe(true)
  })

  it("does not match a number that merely CONTAINS the digits", () => {
    // Arrange — #142 is not what someone typing "42" is looking for.
    const target = pull({ number: 142 })
    const query = "42"

    // Act
    const matched = matchesPullQuery(target, query)

    // Assert
    expect(matched).toBe(false)
  })

  it("matches everything while the box is empty or only spaces", () => {
    // Arrange
    const target = pull({ number: 42 })
    const blank = "   "

    // Act
    const matched = matchesPullQuery(target, blank)

    // Assert
    expect(matched).toBe(true)
  })

  it("matches nothing when neither the number nor the title contains the query", () => {
    // Arrange
    const target = pull({ number: 42, title: "Add login rate limiting" })
    const query = "checkout"

    // Act
    const matched = matchesPullQuery(target, query)

    // Assert
    expect(matched).toBe(false)
  })
})
