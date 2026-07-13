import { describe, expect, it } from "vitest"

import { parseJsonc } from "../src/utils/jsonc.js"

// tsconfig.json is JSONC — TypeScript accepts comments and trailing commas, and real repos
// use both. The scan must be string-aware: a `//` inside a string literal is data, not a
// comment, and a broken config must degrade to null rather than sink the analysis.

describe("parseJsonc — comments and trailing commas", () => {
  it("strips line comments, block comments, and a trailing comma", () => {
    // Arrange
    const text = `{
      // setup absolute import
      "compilerOptions": {
        /* the alias block */
        "baseUrl": "./src/",
        "paths": { "@/*": ["*"] },
      },
    }`

    // Act
    const parsed = parseJsonc(text)

    // Assert
    const expected = { compilerOptions: { baseUrl: "./src/", paths: { "@/*": ["*"] } } }
    expect(parsed).toEqual(expected)
  })
})

describe("parseJsonc — string awareness", () => {
  it("keeps a // sequence that lives inside a string literal", () => {
    // Arrange — a URL in a value; a naive comment strip would truncate it to "https:".
    const homepage = "https://example.com/docs"
    const text = `{ "homepage": "${homepage}" }`

    // Act
    const parsed = parseJsonc(text)

    // Assert
    const expected = { homepage }
    expect(parsed).toEqual(expected)
  })

  it("does not end a string early on an escaped quote", () => {
    // Arrange
    const quoted = 'a\\"b'
    const text = `{ "value": "${quoted}", "after": 1 }`

    // Act
    const parsed = parseJsonc(text)

    // Assert
    const expected = { value: 'a"b', after: 1 }
    expect(parsed).toEqual(expected)
  })
})

describe("parseJsonc — defensive", () => {
  it("returns null for text that is not JSON even after stripping", () => {
    // Arrange
    const brokenText = "{ this is not json"

    // Act
    const parsed = parseJsonc(brokenText)

    // Assert
    expect(parsed).toBeNull()
  })
})
