import { describe, expect, it } from "vitest"

import type { AnalysisResult } from "@pr-visulizer/shared"

import { pr42Analysis, pr42Paths } from "@/service/fixture/pr42"

import { derivePrView } from "./deriveView"

// The tray/graph must present PR #42 in the static order of §8.1 and show the live
// readiness of §8.2 — both sourced from the shared ranking core, not re-derived.

describe("derivePrView — ranking to tray ordering (§8.1)", () => {
  it("orders the tray by the foundations-first static order", () => {
    // Arrange
    const noneReviewed: string[] = []
    const expectedOrder = [
      pr42Paths.limits,
      pr42Paths.http,
      pr42Paths.rateLimiter,
      pr42Paths.withRateLimit,
      pr42Paths.test,
      pr42Paths.login,
    ]

    // Act
    const view = derivePrView(pr42Analysis, noneReviewed)
    const actualOrder = view.trayRows.map((row) => row.path)

    // Assert
    expect(actualOrder).toEqual(expectedOrder)
  })

  it("branch mode walks each dependency branch start→end, sharing foundations once (§8.4)", () => {
    // Arrange
    const noneReviewed: string[] = []
    // test's branch (limits → rateLimiter → test) fully, then login's branch (http →
    // withRateLimit → login); limits + rateLimiter, already reviewed with branch 1, aren't
    // repeated. Contrast with the interleaved foundations order asserted above.
    const expectedBranchOrder = [
      pr42Paths.limits,
      pr42Paths.rateLimiter,
      pr42Paths.test,
      pr42Paths.http,
      pr42Paths.withRateLimit,
      pr42Paths.login,
    ]

    // Act
    const view = derivePrView(pr42Analysis, noneReviewed, [], "branch")
    const actualOrder = view.trayRows.map((row) => row.path)

    // Assert
    expect(actualOrder).toEqual(expectedBranchOrder)
  })

  it("suggests limits.ts first (readiness 1.0, highest fan-in)", () => {
    // Arrange
    const noneReviewed: string[] = []
    const expectedNext = pr42Paths.limits

    // Act
    const view = derivePrView(pr42Analysis, noneReviewed)

    // Assert
    expect(view.suggestedPath).toBe(expectedNext)
    expect(view.trayRows.find((row) => row.isNext)?.path).toBe(expectedNext)
  })
})

describe("derivePrView — live readiness (§8.2)", () => {
  it("computes readiness of every unreviewed file with nothing reviewed yet", () => {
    // Arrange
    const noneReviewed: string[] = []
    const expected: Record<string, number> = {
      [pr42Paths.limits]: 1,
      [pr42Paths.http]: 1,
      [pr42Paths.rateLimiter]: 0,
      [pr42Paths.withRateLimit]: 0,
      [pr42Paths.test]: 0,
      [pr42Paths.login]: 0,
    }

    // Act
    const view = derivePrView(pr42Analysis, noneReviewed)
    const actual = Object.fromEntries(view.trayRows.map((row) => [row.path, row.readiness]))

    // Assert
    expect(actual).toEqual(expected)
  })

  it("recomputes readiness and suggests withRateLimit at the 3/6 checkpoint (§8.2 step 4)", () => {
    // Arrange — limits, http, rateLimiter reviewed. §8.2 step 4: withRateLimit and
    // test both reach readiness 1.0; the tie breaks to withRateLimit on higher fan-in.
    const reviewedFiles = [pr42Paths.limits, pr42Paths.http, pr42Paths.rateLimiter]
    const expectedNext = pr42Paths.withRateLimit

    // Act
    const view = derivePrView(pr42Analysis, reviewedFiles)
    const byPath = Object.fromEntries(view.trayRows.map((row) => [row.path, row]))

    // Assert
    expect(view.reviewedCount).toBe(3)
    expect(view.suggestedPath).toBe(expectedNext)
    expect(byPath[pr42Paths.withRateLimit]!.readiness).toBe(1)
    expect(byPath[pr42Paths.test]!.readiness).toBe(1)
    expect(byPath[pr42Paths.login]!.readiness).toBe(0)
  })

  it("reports all-reviewed once every file is checked", () => {
    // Arrange
    const allFiles = pr42Analysis.files.map((file) => file.path)

    // Act
    const view = derivePrView(pr42Analysis, allFiles)

    // Assert
    expect(view.allReviewed).toBe(true)
    expect(view.suggestedPath).toBeNull()
  })
})

// The suggestion must speak the same language as the chosen order (§8.4). Before this, the
// tray walked one dependency chain while the `isNext` badge came from the §8.2 readiness pick
// and could land in a different chain — the PR #1087 report ("suggests files on a non-related
// branch").
describe("derivePrView — the suggestion agrees with the queue mode (§8.4)", () => {
  // NOTE: on PR #42 the readiness pick happens to COINCIDE with the tray head at step 0, so
  // this case cannot catch the bug on its own — it pins the badge/suggestion/tray wiring.
  // The two-chain cases below are what actually catch it.
  it("branch mode agrees with the tray head, badge and suggestion all on one file", () => {
    // Arrange
    const noneReviewed: string[] = []
    const noDrafts = undefined
    const branchMode = "branch" as const

    // Act
    const view = derivePrView(pr42Analysis, noneReviewed, noDrafts, branchMode)

    // Assert — badge, suggestion and tray head are the same file.
    const expectedSuggestion = view.trayRows[0]!.path
    expect(view.suggestedPath).toBe(expectedSuggestion)
    expect(view.trayRows.filter((row) => row.isNext).map((row) => row.path)).toEqual([
      expectedSuggestion,
    ])
  })

  it("branch mode keeps following the tray as files are reviewed", () => {
    // Arrange — check off the first two rows of the branch order.
    const branchMode = "branch" as const
    const fullView = derivePrView(pr42Analysis, [], undefined, branchMode)
    const reviewedFiles = [fullView.trayRows[0]!.path, fullView.trayRows[1]!.path]

    // Act
    const view = derivePrView(pr42Analysis, reviewedFiles, undefined, branchMode)

    // Assert — the third row, still inside the same branch; never a jump to another chain.
    const expectedSuggestion = fullView.trayRows[2]!.path
    expect(view.suggestedPath).toBe(expectedSuggestion)
  })

  it("foundations mode keeps the §8.2 readiness pick, not the tray head", () => {
    // Arrange — reviewing `limits` alone makes `http` the readiness winner; the tray head is
    // still `limits` (reviewed), so the two rules are distinguishable here.
    const reviewedFiles = [pr42Paths.limits]
    const foundationsMode = "foundations" as const

    // Act
    const view = derivePrView(pr42Analysis, reviewedFiles, undefined, foundationsMode)

    // Assert
    const expectedSuggestion = pr42Paths.http
    expect(view.suggestedPath).toBe(expectedSuggestion)
  })

  it("suggests nothing once every file is reviewed, in either mode", () => {
    // Arrange
    const everyPath = pr42Analysis.files.map((file) => file.path)

    // Act
    const branchView = derivePrView(pr42Analysis, everyPath, undefined, "branch")
    const foundationsView = derivePrView(pr42Analysis, everyPath, undefined, "foundations")

    // Assert
    expect(branchView.suggestedPath).toBeNull()
    expect(foundationsView.suggestedPath).toBeNull()
  })
})

// The PR #1087 shape at the view level: two disjoint service chains sharing one foundation.
// PR #42 is a single connected graph, so it cannot express "a non-related branch" at all —
// only a fixture with two chains can catch the suggestion hopping between them.
describe("derivePrView — two disjoint chains, branch mode never hops (§8.4)", () => {
  const lib = "lib/filter.go"
  const bffRepo = "bff/repo.go"
  const bffHandler = "bff/handler.go"
  const msgRepo = "msg/repo.go"
  const msgHandler = "msg/handler.go"

  const serviceOf = (path: string): string => path.slice(0, path.indexOf("/"))

  const file = (path: string, churn: number) => ({
    path,
    status: "modified" as const,
    additions: churn,
    deletions: 0,
    language: "go",
  })

  const edge = (from: string, to: string) => ({
    from,
    to,
    kind: "imports" as const,
    level: "file" as const,
    source: "ast" as const,
  })

  const twoChainAnalysis: AnalysisResult = {
    engine: "deep",
    pr: {
      owner: "wisesight",
      repo: "analytics-suite",
      number: 1087,
      title: "[MDT-1391] APIX GetMessage",
      author: "octocat",
      baseSha: "base1087",
      headSha: "head1087",
    },
    files: [
      file(lib, 5),
      file(bffRepo, 10),
      file(bffHandler, 30),
      file(msgRepo, 11),
      file(msgHandler, 31),
    ],
    symbols: [],
    edges: [
      edge(bffHandler, bffRepo),
      edge(bffHandler, lib),
      edge(msgHandler, msgRepo),
      edge(msgHandler, lib),
    ],
    ranking: [],
    ghosts: [],
    occurrences: [],
  }

  it("walks one service's chain to exhaustion before starting the other", () => {
    // Arrange — follow the highlight, checking off whatever it points at.
    const branchMode = "branch" as const
    const reviewed: string[] = []

    // Act
    for (let step = 0; step < twoChainAnalysis.files.length; step += 1) {
      const view = derivePrView(twoChainAnalysis, reviewed, undefined, branchMode)
      if (!view.suggestedPath) break

      reviewed.push(view.suggestedPath)
    }

    // Assert — the shared foundation, then one whole service, then the other: 2 switches.
    // The old readiness pick alternated services and scored 4.
    const expectedSwitches = 2
    const switches = reviewed.filter(
      (path, index) => index > 0 && serviceOf(path) !== serviceOf(reviewed[index - 1]!)
    ).length

    expect(reviewed).toHaveLength(twoChainAnalysis.files.length)
    expect(switches).toBe(expectedSwitches)
  })

  it("always highlights the first unreviewed tray row, mid-session", () => {
    // Arrange
    const branchMode = "branch" as const
    const initial = derivePrView(twoChainAnalysis, [], undefined, branchMode)
    const reviewedFiles = [initial.trayRows[0]!.path, initial.trayRows[1]!.path]

    // Act
    const view = derivePrView(twoChainAnalysis, reviewedFiles, undefined, branchMode)
    const firstUnreviewed = view.trayRows.find((row) => !row.reviewed)!

    // Assert
    const expectedSuggestion = firstUnreviewed.path
    expect(view.suggestedPath).toBe(expectedSuggestion)
  })
})
