import { describe, expect, it } from "vitest"

import { isMarkdownPath } from "./markdownPath"

describe("isMarkdownPath", () => {
  it("accepts .md and .markdown, whatever the case", () => {
    // Arrange
    const readme = "README.md"
    const nested = "docs/guides/setup.markdown"
    const shouty = "CHANGELOG.MD"

    // Act
    const results = [isMarkdownPath(readme), isMarkdownPath(nested), isMarkdownPath(shouty)]

    // Assert
    const expected = [true, true, true]
    expect(results).toEqual(expected)
  })

  it("rejects code files and .mdx", () => {
    // Arrange — .mdx is JSX-in-markdown: a plain markdown renderer would silently drop its
    // components and show a document the author never wrote.
    const source = "src/lib/rateLimiter.ts"
    const mdx = "docs/page.mdx"
    const lookalike = "notes.md.bak"

    // Act
    const results = [isMarkdownPath(source), isMarkdownPath(mdx), isMarkdownPath(lookalike)]

    // Assert
    const expected = [false, false, false]
    expect(results).toEqual(expected)
  })
})
