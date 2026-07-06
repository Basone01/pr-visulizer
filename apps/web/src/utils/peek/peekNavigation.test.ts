import { describe, expect, it } from "vitest"

import type { SymbolAnchor } from "@/entity/anchor"

import { initialNavState, makeNavReducer } from "./peekNavigation"

// The peek -> expand -> jump ladder (§10): peek pushes nothing, only a real jump
// pushes the stack, and Esc unwinds peek-then-jumps. Tested in isolation.

const withRateLimitPath = "src/middleware/withRateLimit.ts"
const rateLimiterPath = "src/lib/rateLimiter.ts"

// A usage of createRateLimiter whose definition lives in another file.
const createRateLimiterUsage: SymbolAnchor = {
  symbolId: `${rateLimiterPath}#createRateLimiter`,
  name: "createRateLimiter",
  role: "usage",
  line: 5,
  hasCounterpart: true,
  definition: { path: rateLimiterPath, line: 3 },
  usages: [],
}

const reducer = makeNavReducer({ peekMaxLines: 15 })

describe("peek navigation — peek step", () => {
  it("opens a peek without touching the jump stack (peek pushes nothing)", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const shortDefinition = 5

    // Act
    const next = reducer(start, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionLineCount: shortDefinition,
    })

    // Assert
    expect(next.peek?.target).toEqual({ path: rateLimiterPath, line: 3 })
    expect(next.peek?.truncated).toBe(false)
    expect(next.jumpStack).toEqual([])
  })

  it("marks a long definition truncated, then expands it in place", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const longDefinition = 17 // > peekMaxLines 15

    // Act
    const peeked = reducer(start, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionLineCount: longDefinition,
    })
    const expanded = reducer(peeked, { type: "expandPeek" })

    // Assert
    expect(peeked.peek?.truncated).toBe(true)
    expect(peeked.peek?.expanded).toBe(false)
    expect(expanded.peek?.expanded).toBe(true)
    expect(expanded.jumpStack).toEqual([]) // expand is still not a jump
  })
})

describe("peek navigation — jump step", () => {
  it("pushes the origin onto the jump stack and flash-highlights the target", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const origin = { path: withRateLimitPath, line: 1 }
    const target = { path: rateLimiterPath, line: 3 }

    // Act
    const jumped = reducer(start, { type: "jumpToDefinition", anchor: createRateLimiterUsage })

    // Assert
    expect(jumped.current).toEqual(target)
    expect(jumped.jumpStack).toEqual([origin])
    expect(jumped.flash).toEqual(target)
    expect(jumped.peek).toBeNull()
  })

  it("returns exactly where you left via back", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const origin = { path: withRateLimitPath, line: 1 }

    // Act
    const jumped = reducer(start, { type: "jumpToDefinition", anchor: createRateLimiterUsage })
    const returned = reducer(jumped, { type: "back" })

    // Assert
    expect(returned.current).toEqual(origin)
    expect(returned.jumpStack).toEqual([])
  })
})

describe("peek navigation — Esc unwinds peek before jumps", () => {
  it("Esc closes an open peek first, then pops the jump stack", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const origin = { path: withRateLimitPath, line: 1 }

    // Act
    const jumped = reducer(start, { type: "jumpToDefinition", anchor: createRateLimiterUsage })
    const peeked = reducer(jumped, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionLineCount: 5,
    })
    const closedPeek = reducer(peeked, { type: "escape" })
    const wentBack = reducer(closedPeek, { type: "escape" })

    // Assert
    expect(closedPeek.peek).toBeNull()
    expect(closedPeek.jumpStack).toEqual([origin]) // still in the detour
    expect(wentBack.current).toEqual(origin) // second Esc pops the stack
    expect(wentBack.jumpStack).toEqual([])
  })
})
