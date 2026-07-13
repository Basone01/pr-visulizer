import { describe, expect, it } from "vitest"

import {
  type DependencyGraph,
  RANKING_PRESETS,
  type RankedFile,
  type RankingInput,
  rankFiles,
  readiness,
  suggestNext,
  suggestNextInOrder,
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

// Branch-first ordering (§8.4). Two branches — root1→mid1→leaf and root2→mid2→leaf — that
// share the foundation `leaf`. foundations-first (sort) groups by topo level, interleaving the
// two branches (both mids together, then both roots). branch mode instead walks one branch
// start→end before the next, keeping each contiguous.
describe("branch-first order — walk each branch start→end (§8.4)", () => {
  const leaf = "src/leaf.ts"
  const mid1 = "src/mid1.ts"
  const mid2 = "src/mid2.ts"
  const root1 = "src/root1.ts"
  const root2 = "src/root2.ts"

  const twoBranchInput: RankingInput = {
    files: [leaf, mid1, mid2, root1, root2].map((path) => ({ path, churn: 10 })),
    edges: [
      { from: root1, to: mid1 },
      { from: mid1, to: leaf },
      { from: root2, to: mid2 },
      { from: mid2, to: leaf },
    ],
  }

  it("sort mode interleaves the branches by topo level", () => {
    // Arrange
    const policy = RANKING_PRESETS["foundations-first"]
    const expectedOrder = [leaf, mid1, mid2, root1, root2]

    // Act
    const ranked = rankFiles(twoBranchInput, policy)

    // Assert
    expect(ranked.map((file) => file.path)).toEqual(expectedOrder)
  })

  it("branch mode emits each branch foundation→top before the next, sharing leaf once", () => {
    // Arrange
    const policy = RANKING_PRESETS["dependency-branch"]
    // Branch 1 (leaf → mid1 → root1) fully, then branch 2 (mid2 → root2); leaf, already
    // reviewed with branch 1, is not repeated.
    const expectedOrder = [leaf, mid1, root1, mid2, root2]

    // Act
    const ranked = rankFiles(twoBranchInput, policy)

    // Assert
    expect(ranked.map((file) => file.path)).toEqual(expectedOrder)
    expect(ranked.map((file) => file.order)).toEqual([1, 2, 3, 4, 5])
  })
})

// Branch-mode "best next" (§8.4). The bug (PR #1087): the tray walked one dependency chain
// start→end, but the "next" highlight came from the §8.2 readiness pick, which maximises
// readiness across the WHOLE graph. On a PR whose changed files form two disjoint chains —
// #1087 touched two separate Go services — every chain's foundation scores readiness 1.0, so
// the highlight alternated between unrelated services on every checkmark.
describe("branch-mode next — stay in the current chain (§8.4)", () => {
  // The PR #1087 shape, minimised: two disjoint service chains + a shared lib foundation.
  const lib = "lib/filter/filter.go"
  const bffRepo = "bff/internal/repo/repo.go"
  const bffUsecase = "bff/internal/usecase/usecase.go"
  const bffHandler = "bff/internal/http/rest/handler.go"
  const msgRepo = "service/message/pkg/repo/repo.go"
  const msgUsecase = "service/message/pkg/usecase/usecase.go"
  const msgHandler = "service/message/pkg/http/rest/handler.go"

  const twoServiceInput: RankingInput = {
    files: [
      { path: lib, churn: 5 },
      { path: bffRepo, churn: 10 },
      { path: bffUsecase, churn: 20 },
      { path: bffHandler, churn: 30 },
      { path: msgRepo, churn: 11 },
      { path: msgUsecase, churn: 21 },
      { path: msgHandler, churn: 31 },
    ],
    edges: [
      { from: bffHandler, to: bffUsecase },
      { from: bffUsecase, to: bffRepo },
      { from: bffHandler, to: lib },
      { from: msgHandler, to: msgUsecase },
      { from: msgUsecase, to: msgRepo },
      { from: msgHandler, to: lib },
    ],
  }

  const serviceOf = (path: string): string =>
    path.startsWith("bff/") ? "bff" : path.startsWith("service/message/") ? "msg" : "lib"

  function branchOrder(): string[] {
    return rankFiles(twoServiceInput, RANKING_PRESETS["dependency-branch"]).map((file) => file.path)
  }

  it("keeps each service's chain contiguous in the branch order", () => {
    // Arrange
    const expectedServiceRuns = ["lib", "msg", "msg", "msg", "bff", "bff", "bff"]

    // Act
    const services = branchOrder().map(serviceOf)

    // Assert — the shared foundation once, then one whole service, then the other.
    expect(services).toEqual(expectedServiceRuns)
  })

  it("suggests every file of one chain before touching the other", () => {
    // Arrange — follow the suggestion, checkmarking whatever it points at.
    const ordered = branchOrder()
    const reviewed: string[] = []

    // Act
    for (let step = 0; step < ordered.length; step += 1) {
      const next = suggestNextInOrder(ordered, reviewed)
      if (!next) break

      reviewed.push(next)
    }

    // Assert — no chain switch beyond the two run boundaries (lib→msg, msg→bff).
    const expectedWalk = ordered
    const expectedChainSwitches = 2
    const switches = reviewed.filter(
      (path, index) => index > 0 && serviceOf(path) !== serviceOf(reviewed[index - 1]!)
    ).length

    expect(reviewed).toEqual(expectedWalk)
    expect(switches).toBe(expectedChainSwitches)
  })

  it("is the readiness pick that hops chains — the bug this replaces", () => {
    // Arrange — the same graph, driven by the §8.2 readiness pick instead.
    const graph = {
      nodes: twoServiceInput.files.map((file) => file.path),
      edges: twoServiceInput.edges,
    }
    const reviewed: string[] = []

    // Act
    for (let step = 0; step < graph.nodes.length; step += 1) {
      const next = suggestNext(graph, reviewed)
      if (!next) break

      reviewed.push(next)
    }

    // Assert — readiness alternates between the two unrelated services (6 switches, not 2).
    // This documents WHY branch mode needs its own suggestion, and pins the old behaviour
    // so foundations mode never silently inherits the branch rule.
    const expectedChainSwitches = 6
    const switches = reviewed.filter(
      (path, index) => index > 0 && serviceOf(path) !== serviceOf(reviewed[index - 1]!)
    ).length

    expect(switches).toBe(expectedChainSwitches)
  })

  it("skips already-reviewed files and returns null once the queue is empty", () => {
    // Arrange
    const ordered = branchOrder()
    const reviewedPrefix = [ordered[0]!, ordered[1]!]

    // Act
    const next = suggestNextInOrder(ordered, reviewedPrefix)
    const exhausted = suggestNextInOrder(ordered, ordered)

    // Assert
    const expectedNext = ordered[2]!
    expect(next).toBe(expectedNext)
    expect(exhausted).toBeNull()
  })
})
