import { describe, expect, it } from "vitest"

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
