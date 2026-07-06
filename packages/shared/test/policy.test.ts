import { describe, expect, it } from "vitest"

import {
  DEFAULT_RANKING_POLICY,
  RANKING_PRESETS,
  type RankingPolicy,
  rankFiles,
  resolveRankingPolicy,
} from "../src/index.js"
import { pr42Paths, pr42RankingInput } from "./fixtures/pr42.js"

// Presets are data — test that each one RESOLVES to the settings we expect,
// separately from testing the behaviour those settings produce (§8.3).
describe("ranking policy — preset resolution (§8.3)", () => {
  it("foundations-first is the default preset", () => {
    // Arrange
    const expected: RankingPolicy = {
      primary: "topoLevel",
      tieBreakers: ["fanIn", "churn", "path"],
    }

    // Act
    const preset = RANKING_PRESETS["foundations-first"]

    // Assert
    expect(preset).toEqual(expected)
    expect(DEFAULT_RANKING_POLICY).toEqual(expected)
  })

  it("blast-radius-first sorts by fan-in first", () => {
    // Arrange
    const expected: RankingPolicy = {
      primary: "fanIn",
      tieBreakers: ["topoLevel", "churn", "path"],
    }

    // Act
    const preset = RANKING_PRESETS["blast-radius-first"]

    // Assert
    expect(preset).toEqual(expected)
  })

  it("quick-wins sorts by ascending churn first", () => {
    // Arrange
    const expected: RankingPolicy = {
      primary: "churnAsc",
      tieBreakers: ["topoLevel", "fanIn", "path"],
    }

    // Act
    const preset = RANKING_PRESETS["quick-wins"]

    // Assert
    expect(preset).toEqual(expected)
  })

  it("resolves a preset by name with no overrides", () => {
    // Arrange
    const presetName = "quick-wins" as const
    const expected = RANKING_PRESETS["quick-wins"]

    // Act
    const resolved = resolveRankingPolicy(presetName)

    // Assert
    expect(resolved).toEqual(expected)
  })

  it("resolves defaults ← preset ← overrides, with overrides winning", () => {
    // Arrange
    const presetName = "foundations-first" as const
    const overrides: Partial<RankingPolicy> = { primary: "fanIn" }
    const expected: RankingPolicy = {
      primary: "fanIn", // override wins over the preset's "topoLevel"
      tieBreakers: ["fanIn", "churn", "path"], // preset value kept
    }

    // Act
    const resolved = resolveRankingPolicy(presetName, overrides)

    // Assert
    expect(resolved).toEqual(expected)
  })
})

// Behaviour of the resolved settings — a different preset yields a different order,
// tested separately from the resolution above.
describe("ranking policy — preset behaviour (§8.3)", () => {
  it("quick-wins puts the smallest-churn file first", () => {
    // Arrange
    const input = pr42RankingInput
    const policy = RANKING_PRESETS["quick-wins"]
    const expectedFirstTwo = [pr42Paths.http, pr42Paths.limits] // churn 3, then 4

    // Act
    const ranked = rankFiles(input, policy)
    const firstTwo = ranked.slice(0, 2).map((file) => file.path)

    // Assert
    expect(firstTwo).toEqual(expectedFirstTwo)
  })

  it("blast-radius-first puts the highest fan-in file first", () => {
    // Arrange
    const input = pr42RankingInput
    const policy = RANKING_PRESETS["blast-radius-first"]
    const expectedFirstTwo = [pr42Paths.limits, pr42Paths.rateLimiter] // fanIn 3, then 2

    // Act
    const ranked = rankFiles(input, policy)
    const firstTwo = ranked.slice(0, 2).map((file) => file.path)

    // Assert
    expect(firstTwo).toEqual(expectedFirstTwo)
  })
})
