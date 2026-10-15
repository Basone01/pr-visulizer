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

const reducer = makeNavReducer({ peekMaxLines: 15, usagePeekContextLines: 3 })

describe("peek navigation — peek step", () => {
  it("opens a peek without touching the jump stack (peek pushes nothing)", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const shortDefinition = { startLine: 3, endLine: 7 } // 5 lines

    // Act
    const next = reducer(start, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionSpan: shortDefinition,
    })

    // Assert
    expect(next.peek?.target).toEqual({ path: rateLimiterPath, line: 3 })
    expect(next.peek?.truncated).toBe(false)
    expect(next.jumpStack).toEqual([])
  })

  it("marks a long definition truncated, then expands it in place", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const longDefinition = { startLine: 3, endLine: 19 } // 17 lines > peekMaxLines 15

    // Act
    const peeked = reducer(start, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionSpan: longDefinition,
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

describe("peek navigation — closing a peek", () => {
  it("closes the peek without touching the detour the reviewer is inside", () => {
    // Arrange — peeking from INSIDE a jump, so a close that wrongly unwound the stack would
    // teleport the reviewer back to where the detour started. This is what the × dispatches.
    const start = initialNavState(withRateLimitPath)
    const origin = { path: withRateLimitPath, line: 1 }
    const jumped = reducer(start, { type: "jumpToDefinition", anchor: createRateLimiterUsage })
    const peeked = reducer(jumped, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionSpan: { startLine: 3, endLine: 7 },
    })

    // Act
    const closed = reducer(peeked, { type: "closePeek" })

    // Assert — the peek is gone and nothing else moved.
    expect(closed.peek).toBeNull()
    expect(closed.current).toEqual(jumped.current)
    expect(closed.jumpStack).toEqual([origin])
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
      definitionSpan: { startLine: 3, endLine: 7 },
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

describe("peek navigation — peeking a usage site from the usages popover", () => {
  // The definition whose "N usages" popover is open, with one caller in another file.
  const createRateLimiterDefinition: SymbolAnchor = {
    symbolId: `${rateLimiterPath}#createRateLimiter`,
    name: "createRateLimiter",
    role: "definition",
    line: 3,
    hasCounterpart: true,
    definition: null,
    usages: [{ path: withRateLimitPath, line: 10 }],
  }

  it("peeks_a_usage_site_with_context_lines_around_it", () => {
    // Arrange
    const start = initialNavState(rateLimiterPath)
    const usageSite = { path: withRateLimitPath, line: 10 }

    // Act
    const next = reducer(start, {
      type: "peekUsageSite",
      anchor: createRateLimiterDefinition,
      target: usageSite,
    })

    // Assert
    const expected = {
      kind: "usage",
      anchor: createRateLimiterDefinition,
      target: usageSite,
      span: { startLine: 7, endLine: 13 },
      truncated: false,
      expanded: false,
    }
    expect(next.peek).toEqual(expected)
  })

  it("clamps_a_usage_peek_span_at_the_first_line", () => {
    // Arrange
    const start = initialNavState(rateLimiterPath)
    const usageSite = { path: withRateLimitPath, line: 2 }

    // Act
    const next = reducer(start, {
      type: "peekUsageSite",
      anchor: createRateLimiterDefinition,
      target: usageSite,
    })

    // Assert
    const expected = { startLine: 1, endLine: 5 }
    expect(next.peek?.span).toEqual(expected)
  })

  it("replaces_an_open_definition_peek_when_a_usage_site_is_peeked", () => {
    // Arrange
    const start = initialNavState(withRateLimitPath)
    const definitionPeek = reducer(start, {
      type: "peekUsage",
      anchor: createRateLimiterUsage,
      definitionSpan: { startLine: 3, endLine: 7 },
    })
    const usageSite = { path: withRateLimitPath, line: 10 }

    // Act
    const next = reducer(definitionPeek, {
      type: "peekUsageSite",
      anchor: createRateLimiterDefinition,
      target: usageSite,
    })

    // Assert
    const expected = { kind: "usage", target: usageSite }
    expect({ kind: next.peek?.kind, target: next.peek?.target }).toEqual(expected)
  })

  it("jumping_from_a_usage_peek_pushes_the_jump_stack", () => {
    // Arrange
    const start = initialNavState(rateLimiterPath)
    const origin = { path: rateLimiterPath, line: 1 }
    const usageSite = { path: withRateLimitPath, line: 10 }
    const peeked = reducer(start, {
      type: "peekUsageSite",
      anchor: createRateLimiterDefinition,
      target: usageSite,
    })

    // Act
    const jumped = reducer(peeked, { type: "jumpTo", target: usageSite })

    // Assert
    const expected = { current: usageSite, jumpStack: [origin], peek: null }
    expect({ current: jumped.current, jumpStack: jumped.jumpStack, peek: jumped.peek }).toEqual(
      expected
    )
  })
})
