import { describe, expect, it } from "vitest"

import type { LayoutEdge } from "@/utils/graph/elkLayout"

import { focusAroundPath } from "./graphFocus"

// Focus + context around the open file — and what happens when a commit range filters that file
// off the canvas (§10).

const LIMITS_PATH = "src/config/limits.ts"
const RATE_LIMITER_PATH = "src/lib/rateLimiter.ts"
const LOGIN_PATH = "src/api/routes/login.ts"

const edges: LayoutEdge[] = [
  { from: RATE_LIMITER_PATH, to: LIMITS_PATH },
  { from: LOGIN_PATH, to: RATE_LIMITER_PATH },
]

describe("focusAroundPath", () => {
  it("focuses the open file and its DIRECT neighbours on both sides of the arrow", () => {
    // Arrange
    const currentPath = RATE_LIMITER_PATH
    const visiblePaths = new Set([LIMITS_PATH, RATE_LIMITER_PATH, LOGIN_PATH])

    // Act
    const focus = focusAroundPath(currentPath, edges, visiblePaths)

    // Assert — what it depends on AND what depends on it; nothing further out.
    const expected = { currentPath: RATE_LIMITER_PATH, focused: 3 }
    expect({ currentPath: focus.currentPath, focused: focus.focusSet?.size }).toEqual(expected)
  })

  it("dims nothing when no file is open", () => {
    // Arrange
    const noOpenFile = ""
    const visiblePaths = new Set([LIMITS_PATH, RATE_LIMITER_PATH])

    // Act
    const focus = focusAroundPath(noOpenFile, edges, visiblePaths)

    // Assert — a null focusSet is "no dimming at all".
    const expected = null
    expect(focus.focusSet).toEqual(expected)
  })

  it("dims nothing when a commit range filtered the OPEN file off the canvas", () => {
    // Arrange — login is open, but the range's graph doesn't draw it.
    const currentPath = LOGIN_PATH
    const visiblePaths = new Set([LIMITS_PATH, RATE_LIMITER_PATH])

    // Act
    const focus = focusAroundPath(currentPath, edges, visiblePaths)

    // Assert — highlighting a node that isn't there would grey out the whole filtered graph.
    const expected = { focusSet: null, currentPath: "" }
    expect({ focusSet: focus.focusSet, currentPath: focus.currentPath }).toEqual(expected)
  })
})
