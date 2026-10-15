import { describe, expect, it } from "vitest"

import { type SyntaxToken, createLineTokenizer } from "./highlighter"

// Runs real shiki (pure JS regex engine) — these guard that each new grammar actually
// loads and its key scopes reach a syntax color, not plain body text.

function cssVarOf(tokens: SyntaxToken[], content: string): string | undefined {
  return tokens.find((token) => token.content.trim() === content)?.cssVar
}

describe("createLineTokenizer", () => {
  it("yaml_keys_get_the_type_color", async () => {
    // Arrange
    const path = "docker-compose.yml"
    const line = "image: nginx:1.25"
    const tokenize = await createLineTokenizer(path)

    // Act
    const tokens = tokenize(line)

    // Assert
    const expected = "var(--syn-type)"
    expect(cssVarOf(tokens, "image")).toBe(expected)
  })

  it("dockerfile_instructions_get_the_keyword_color", async () => {
    // Arrange
    const path = "Dockerfile"
    const line = "FROM node:20-alpine"
    const tokenize = await createLineTokenizer(path)

    // Act
    const tokens = tokenize(line)

    // Assert
    const expected = "var(--syn-keyword)"
    expect(cssVarOf(tokens, "FROM")).toBe(expected)
  })

  it("shell_strings_get_the_string_color", async () => {
    // Arrange
    const path = "deploy.sh"
    const line = 'echo "hello"'
    const tokenize = await createLineTokenizer(path)

    // Act
    const tokens = tokenize(line)

    // Assert
    // shiki splits `"hello"` into quote / text / quote tokens, all string-scoped.
    const stringTokens = tokens.slice(tokens.findIndex((token) => token.content.startsWith('"')))
    const expected = ["var(--syn-string)"]
    expect([...new Set(stringTokens.map((token) => token.cssVar))]).toEqual(expected)
  })

  it("json_numbers_get_the_const_color", async () => {
    // Arrange
    const path = "package.json"
    const line = '{"port": 8080}'
    const tokenize = await createLineTokenizer(path)

    // Act
    const tokens = tokenize(line)

    // Assert
    const expected = "var(--syn-const)"
    expect(cssVarOf(tokens, "8080")).toBe(expected)
  })

  it("bruno_block_names_get_the_keyword_color", async () => {
    // Arrange
    const path = "docs/api/Readiness.bru"
    const line = "get {"
    const tokenize = await createLineTokenizer(path)

    // Act
    const tokens = tokenize(line)

    // Assert
    // The grammar captures the whole block opener `get {` as one keyword.bruno token.
    const getToken = tokens.find((token) => token.content.includes("get"))
    const expected = "var(--syn-keyword)"
    expect(getToken?.cssVar).toBe(expected)
  })
})
