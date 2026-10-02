import { describe, expect, it } from "vitest"

import type { GhostNodeVM } from "@/entity/viewModels"

import { buildGhostEdges } from "./ghostEdges"

// The faded ghost → changed-file links (§6, §380). They exist only for React Flow, so the two
// rules that matter are: one edge per changed file a ghost reaches, and never an edge to a file
// the commit-range filter took off the canvas.

const WITH_RATE_LIMIT_PATH = "src/middleware/withRateLimit.ts"
const RATE_LIMITER_PATH = "src/lib/rateLimiter.ts"

const adminGhost: GhostNodeVM = {
  path: "src/api/routes/admin.ts",
  fileName: "admin.ts",
  usedChangedSymbols: [`${WITH_RATE_LIMIT_PATH}#withRateLimit`],
  usesChangedFiles: [RATE_LIMITER_PATH, WITH_RATE_LIMIT_PATH],
}

const healthGhost: GhostNodeVM = {
  path: "src/api/routes/health.ts",
  fileName: "health.ts",
  // Import-only ghost: no symbol to show, but it still reaches a changed file.
  usedChangedSymbols: [],
  usesChangedFiles: [WITH_RATE_LIMIT_PATH],
}

describe("buildGhostEdges", () => {
  it("draws one edge per changed file a ghost reaches", () => {
    // Arrange
    const ghostNodes = [adminGhost]
    const visiblePaths = new Set([RATE_LIMITER_PATH, WITH_RATE_LIMIT_PATH])
    const expected = [
      {
        id: `ghost:${adminGhost.path}->${RATE_LIMITER_PATH}`,
        from: adminGhost.path,
        to: RATE_LIMITER_PATH,
      },
      {
        id: `ghost:${adminGhost.path}->${WITH_RATE_LIMIT_PATH}`,
        from: adminGhost.path,
        to: WITH_RATE_LIMIT_PATH,
      },
    ]

    // Act
    const edges = buildGhostEdges(ghostNodes, visiblePaths)

    // Assert
    expect(edges).toEqual(expected)
  })

  it("draws the edge of an import-only ghost, which has no symbols to show", () => {
    // Arrange
    const ghostNodes = [healthGhost]
    const visiblePaths = new Set([WITH_RATE_LIMIT_PATH])
    const expected = [
      {
        id: `ghost:${healthGhost.path}->${WITH_RATE_LIMIT_PATH}`,
        from: healthGhost.path,
        to: WITH_RATE_LIMIT_PATH,
      },
    ]

    // Act
    const edges = buildGhostEdges(ghostNodes, visiblePaths)

    // Assert
    expect(edges).toEqual(expected)
  })

  it("skips a changed file the commit range filtered off the canvas", () => {
    // Arrange — only the middleware survived the range, so the rateLimiter edge would dangle.
    const ghostNodes = [adminGhost]
    const visiblePaths = new Set([WITH_RATE_LIMIT_PATH])
    const expectedTargets = [WITH_RATE_LIMIT_PATH]

    // Act
    const edges = buildGhostEdges(ghostNodes, visiblePaths)

    // Assert
    expect(edges.map((edge) => edge.to)).toEqual(expectedTargets)
  })

  it("draws nothing for a ghost that reaches no changed file", () => {
    // Arrange
    const isolatedGhost: GhostNodeVM = {
      path: "src/api/routes/legacy.ts",
      fileName: "legacy.ts",
      usedChangedSymbols: [],
      usesChangedFiles: [],
    }
    const visiblePaths = new Set([WITH_RATE_LIMIT_PATH])
    const expected: ReturnType<typeof buildGhostEdges> = []

    // Act
    const edges = buildGhostEdges([isolatedGhost], visiblePaths)

    // Assert
    expect(edges).toEqual(expected)
  })
})
