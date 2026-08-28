import { describe, expect, it } from "vitest"

import { RECENT_FILES_LIMIT, updateRecentFiles } from "./recentFiles"

// The MRU list behind the ⌘P switcher: front = the file on screen, so row 1 is always "the file
// I was in before this one".

describe("updateRecentFiles", () => {
  it("puts the newly viewed file at the front", () => {
    // Arrange
    const recentFiles = ["src/auth/token.ts", "src/config/env.ts"]
    const viewedPath = "src/routes/login.ts"
    const expected = ["src/routes/login.ts", "src/auth/token.ts", "src/config/env.ts"]

    // Act
    const updated = updateRecentFiles(recentFiles, viewedPath)

    // Assert
    expect(updated).toEqual(expected)
  })

  it("moves a re-viewed file to the front instead of listing it twice", () => {
    // Arrange
    const recentFiles = ["src/routes/login.ts", "src/auth/token.ts", "src/config/env.ts"]
    const viewedPath = "src/config/env.ts"
    const expected = ["src/config/env.ts", "src/routes/login.ts", "src/auth/token.ts"]

    // Act
    const updated = updateRecentFiles(recentFiles, viewedPath)

    // Assert
    expect(updated).toEqual(expected)
  })

  it("caps the list at ten, dropping the least recent file", () => {
    // Arrange
    const recentFiles = Array.from(
      { length: RECENT_FILES_LIMIT },
      (_, index) => `src/file${index}.ts`
    )
    const viewedPath = "src/newest.ts"
    const expectedLength = RECENT_FILES_LIMIT
    const droppedPath = "src/file9.ts"

    // Act
    const updated = updateRecentFiles(recentFiles, viewedPath)

    // Assert
    expect(updated).toHaveLength(expectedLength)
    expect(updated[0]).toBe(viewedPath)
    expect(updated).not.toContain(droppedPath)
  })

  it("ignores the empty path — the shell's 'nothing open' state is not a file", () => {
    // Arrange
    const recentFiles = ["src/auth/token.ts", "src/config/env.ts"]
    const viewedPath = ""
    const expected = ["src/auth/token.ts", "src/config/env.ts"]

    // Act
    const updated = updateRecentFiles(recentFiles, viewedPath)

    // Assert
    expect(updated).toEqual(expected)
  })
})
