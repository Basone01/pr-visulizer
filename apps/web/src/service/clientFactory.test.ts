import { describe, expect, it } from "vitest"

import { getAppStorage } from "./clientFactory"

// The app storage is a hook DEPENDENCY (`useEffect([store])` in useDiffViewSettings), so its
// identity is part of its contract: a fresh wrapper per call re-runs that load effect on every
// render, and a read that resolves after a toggle reverts the toggle. Cheap to guarantee, and
// invisible until something races — hence the test.

describe("getAppStorage", () => {
  it("hands back the same instance every call", () => {
    // Arrange / Act
    const first = getAppStorage()
    const second = getAppStorage()

    // Assert
    expect(second).toBe(first)
  })
})
