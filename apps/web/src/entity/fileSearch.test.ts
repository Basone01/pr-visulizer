import { describe, expect, it } from "vitest"

import { type FileMatch, matchFilePath, rankFileMatches } from "./fileSearch"

// The ⌘P palette's ranking. Subsequence matching like VS Code's quick open: the query's
// characters must appear in order, the file name outweighs the folders, and a file the reviewer
// already visited outranks one they have not.

describe("matchFilePath", () => {
  it("scores a file-name match above a folder-only match", () => {
    // Arrange
    const query = "token"
    const namePath = "src/auth/token.ts"
    const folderPath = "src/token/handler.ts"

    // Act
    const nameMatch = matchFilePath(namePath, query)
    const folderMatch = matchFilePath(folderPath, query)

    // Assert
    expect(nameMatch).not.toBeNull()
    expect(folderMatch).not.toBeNull()
    expect(nameMatch!.score).toBeGreaterThan(folderMatch!.score)
  })

  it("marks exactly the characters the query matched", () => {
    // Arrange
    const query = "tok"
    const path = "src/auth/token.ts"
    const expected: FileMatch["matchedIndices"] = [9, 10, 11]

    // Act
    const match = matchFilePath(path, query)

    // Assert
    expect(match?.matchedIndices).toEqual(expected)
  })

  it("matches characters that are apart but in order", () => {
    // Arrange — "a", "t", "k" scattered across folder and file name.
    const query = "atk"
    const path = "src/auth/token.ts"

    // Act
    const match = matchFilePath(path, query)

    // Assert
    expect(match).not.toBeNull()
  })

  it("rejects a query whose characters are out of order", () => {
    // Arrange — the reverse of "tok", which does match.
    const query = "kot"
    const path = "src/auth/token.ts"
    const expected = null

    // Act
    const match = matchFilePath(path, query)

    // Assert
    expect(match).toBe(expected)
  })
})

describe("rankFileMatches", () => {
  const filePaths = [
    "src/auth/token.ts",
    "src/auth/tokenStore.ts",
    "src/routes/login.ts",
    "src/config/env.ts",
  ]

  it("lists the recent files in MRU order when the query is empty", () => {
    // Arrange
    const recentFiles = ["src/routes/login.ts", "src/auth/token.ts"]
    const query = ""
    const expected = ["src/routes/login.ts", "src/auth/token.ts"]

    // Act
    const results = rankFileMatches({ filePaths, recentFiles, query })

    // Assert
    expect(results.map((match) => match.path)).toEqual(expected)
  })

  it("ranks a recently viewed match above a better-scoring one the reviewer has not opened", () => {
    // Arrange — "token" scores higher on token.ts (exact name), but tokenStore.ts was just viewed.
    const recentFiles = ["src/auth/tokenStore.ts"]
    const query = "token"
    const expected = ["src/auth/tokenStore.ts", "src/auth/token.ts"]

    // Act
    const results = rankFileMatches({ filePaths, recentFiles, query })

    // Assert
    expect(results.map((match) => match.path)).toEqual(expected)
  })

  it("drops files the query cannot match", () => {
    // Arrange
    const recentFiles: string[] = []
    const query = "login"
    const expected = ["src/routes/login.ts"]

    // Act
    const results = rankFileMatches({ filePaths, recentFiles, query })

    // Assert
    expect(results.map((match) => match.path)).toEqual(expected)
  })

  it("caps the list at the limit — a big PR must not render every file", () => {
    // Arrange
    const manyPaths = Array.from({ length: 200 }, (_, index) => `src/file${index}.ts`)
    const recentFiles: string[] = []
    const query = "file"
    const limit = 50

    // Act
    const results = rankFileMatches({ filePaths: manyPaths, recentFiles, query, limit })

    // Assert
    expect(results).toHaveLength(limit)
  })
})
