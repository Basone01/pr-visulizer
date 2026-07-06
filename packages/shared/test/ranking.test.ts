import { describe, expect, it } from "vitest"

import {
  type DependencyGraph,
  RANKING_PRESETS,
  type RankedFile,
  rankFiles,
  readiness,
  suggestNext,
  topoLevels,
} from "../src/index.js"
import { pr42Graph, pr42Paths, pr42RankingInput } from "./fixtures/pr42.js"

describe("static order — where to start (§8.1)", () => {
  it("ranks PR #42 in the exact foundations-first order", () => {
    // Arrange
    const input = pr42RankingInput
    const policy = RANKING_PRESETS["foundations-first"]
    const expected: RankedFile[] = [
      { path: pr42Paths.limits, topoLevel: 0, fanIn: 3, churn: 4, order: 1 },
      { path: pr42Paths.http, topoLevel: 0, fanIn: 1, churn: 3, order: 2 },
      { path: pr42Paths.rateLimiter, topoLevel: 1, fanIn: 2, churn: 48, order: 3 },
      { path: pr42Paths.withRateLimit, topoLevel: 2, fanIn: 1, churn: 26, order: 4 },
      { path: pr42Paths.test, topoLevel: 2, fanIn: 0, churn: 52, order: 5 },
      { path: pr42Paths.login, topoLevel: 3, fanIn: 0, churn: 8, order: 6 },
    ]

    // Act
    const ranked = rankFiles(input, policy)

    // Assert
    expect(ranked).toEqual(expected)
  })
})

// Dynamic best-next after every checkmark (§8.2). Each step asserts the readiness
// of every unreviewed file AND the suggestion, including which tie-break decided it.
describe("dynamic best-next — what to review next (§8.2)", () => {
  const graph = pr42Graph
  const { limits, http, rateLimiter, withRateLimit, test, login } = pr42Paths

  it("step 1 — nothing reviewed → suggests limits (tie with http, higher fanIn 3 vs 1)", () => {
    // Arrange
    const reviewedFiles: string[] = []
    const expectedSuggestion = limits

    // Act
    const scores = readiness(graph, reviewedFiles)
    const suggestion = suggestNext(graph, reviewedFiles)

    // Assert
    expect(scores.get(limits)).toBeCloseTo(1.0, 2)
    expect(scores.get(http)).toBeCloseTo(1.0, 2)
    expect(scores.get(rateLimiter)).toBeCloseTo(0.0, 2)
    expect(scores.get(withRateLimit)).toBeCloseTo(0.0, 2)
    expect(scores.get(test)).toBeCloseTo(0.0, 2)
    expect(scores.get(login)).toBeCloseTo(0.0, 2)
    expect(suggestion).toBe(expectedSuggestion)
  })

  it("step 2 — reviewed limits → suggests http (tie with rateLimiter, lower topoLevel 0 vs 1)", () => {
    // Arrange
    const reviewedFiles = [limits]
    const expectedSuggestion = http

    // Act
    const scores = readiness(graph, reviewedFiles)
    const suggestion = suggestNext(graph, reviewedFiles)

    // Assert
    expect(scores.get(http)).toBeCloseTo(1.0, 2)
    expect(scores.get(rateLimiter)).toBeCloseTo(1.0, 2)
    expect(scores.get(withRateLimit)).toBeCloseTo(0.33, 2)
    expect(scores.get(test)).toBeCloseTo(0.5, 2)
    expect(scores.get(login)).toBeCloseTo(0.0, 2)
    expect(suggestion).toBe(expectedSuggestion)
  })

  it("step 3 — reviewed limits, http → suggests rateLimiter", () => {
    // Arrange
    const reviewedFiles = [limits, http]
    const expectedSuggestion = rateLimiter

    // Act
    const scores = readiness(graph, reviewedFiles)
    const suggestion = suggestNext(graph, reviewedFiles)

    // Assert
    expect(scores.get(rateLimiter)).toBeCloseTo(1.0, 2)
    expect(scores.get(withRateLimit)).toBeCloseTo(0.67, 2)
    expect(scores.get(test)).toBeCloseTo(0.5, 2)
    expect(scores.get(login)).toBeCloseTo(0.0, 2)
    expect(suggestion).toBe(expectedSuggestion)
  })

  it("step 4 — reviewed limits, http, rateLimiter → suggests withRateLimit (tie with test, higher fanIn 1 vs 0)", () => {
    // Arrange
    const reviewedFiles = [limits, http, rateLimiter]
    const expectedSuggestion = withRateLimit

    // Act
    const scores = readiness(graph, reviewedFiles)
    const suggestion = suggestNext(graph, reviewedFiles)

    // Assert
    expect(scores.get(withRateLimit)).toBeCloseTo(1.0, 2)
    expect(scores.get(test)).toBeCloseTo(1.0, 2)
    expect(scores.get(login)).toBeCloseTo(0.0, 2)
    expect(suggestion).toBe(expectedSuggestion)
  })

  it("step 5 — + withRateLimit → suggests test (tie with login, lower topoLevel 2 vs 3)", () => {
    // Arrange
    const reviewedFiles = [limits, http, rateLimiter, withRateLimit]
    const expectedSuggestion = test

    // Act
    const scores = readiness(graph, reviewedFiles)
    const suggestion = suggestNext(graph, reviewedFiles)

    // Assert
    expect(scores.get(test)).toBeCloseTo(1.0, 2)
    expect(scores.get(login)).toBeCloseTo(1.0, 2)
    expect(suggestion).toBe(expectedSuggestion)
  })

  it("step 6 — only login left → suggests login, then null when done", () => {
    // Arrange
    const reviewedFiles = [limits, http, rateLimiter, withRateLimit, test]
    const expectedSuggestion = login

    // Act
    const scores = readiness(graph, reviewedFiles)
    const suggestion = suggestNext(graph, reviewedFiles)
    const afterAll = suggestNext(graph, [...reviewedFiles, login])

    // Assert
    expect(scores.get(login)).toBeCloseTo(1.0, 2)
    expect(suggestion).toBe(expectedSuggestion)
    expect(afterAll).toBeNull()
  })

  it("adapts — reviewing login first still points back at limits (never blocks)", () => {
    // Arrange
    const reviewedFiles = [login]
    const expectedSuggestion = limits

    // Act
    const suggestion = suggestNext(graph, reviewedFiles)

    // Assert
    expect(suggestion).toBe(expectedSuggestion)
  })

  it("falls back to path ascending when readiness, topoLevel and fanIn all tie", () => {
    // Arrange
    const graphWithFlatTie: DependencyGraph = {
      nodes: ["src/b.ts", "src/a.ts"],
      edges: [],
    }
    const reviewedFiles: string[] = []
    const expectedSuggestion = "src/a.ts"

    // Act
    const suggestion = suggestNext(graphWithFlatTie, reviewedFiles)

    // Assert
    expect(suggestion).toBe(expectedSuggestion)
  })
})

// Circular imports: Tarjan SCC collapse — members share a topo level (§5 fallback).
describe("cycle handling — SCC collapse (§5)", () => {
  it("gives two mutually-importing files the same topo level", () => {
    // Arrange
    const fileA = "src/a.ts"
    const fileB = "src/b.ts"
    const cyclicGraph: DependencyGraph = {
      nodes: [fileA, fileB],
      edges: [
        { from: fileA, to: fileB },
        { from: fileB, to: fileA },
      ],
    }
    const expectedSharedLevel = 0

    // Act
    const levels = topoLevels(cyclicGraph)

    // Assert
    expect(levels.get(fileA)).toBe(expectedSharedLevel)
    expect(levels.get(fileB)).toBe(expectedSharedLevel)
  })

  it("lifts a cycle above the foundation it depends on, keeping members level-aligned", () => {
    // Arrange
    const fileA = "src/a.ts"
    const fileB = "src/b.ts"
    const foundation = "src/config.ts"
    const cyclicGraph: DependencyGraph = {
      nodes: [fileA, fileB, foundation],
      edges: [
        { from: fileA, to: fileB },
        { from: fileB, to: fileA },
        { from: fileA, to: foundation },
      ],
    }
    const expectedFoundationLevel = 0
    const expectedCycleLevel = 1

    // Act
    const levels = topoLevels(cyclicGraph)

    // Assert
    expect(levels.get(foundation)).toBe(expectedFoundationLevel)
    expect(levels.get(fileA)).toBe(expectedCycleLevel)
    expect(levels.get(fileB)).toBe(expectedCycleLevel)
  })
})
