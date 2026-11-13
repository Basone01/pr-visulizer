import { describe, expect, it } from "vitest"

import { rankFiles, rankReviewFiles, resolveRankingPolicy } from "../src/index.js"
import { pr42RankingInput } from "./fixtures/pr42.js"

describe("the review order with nothing skipped", () => {
  it("ranks PR #42 exactly as the ranking core does", () => {
    // Arrange
    const policy = resolveRankingPolicy("foundations-first")
    const noneSkipped = { ...pr42RankingInput, skipped: [] }

    // Act
    const order = rankReviewFiles(noneSkipped, policy)

    // Assert
    const expected = { ranked: rankFiles(pr42RankingInput, policy), skipped: [] }
    expect(order).toEqual(expected)
  })
})
