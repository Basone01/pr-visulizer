import { describe, expect, it } from "vitest"

import stylesheet from "./Diff.module.css?raw"

// jsdom applies no stylesheet, so this reads the rules themselves.
function declarationOf(selector: string, property: string): string | null {
  const start = stylesheet.indexOf(`${selector} {`)
  if (start === -1) return null

  const block = stylesheet.slice(start, stylesheet.indexOf("}", start))
  return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? null
}

describe("diff pane toolbar", () => {
  it("diff toolbar wraps inside a narrow diff pane instead of leaving it", () => {
    // Arrange
    const toolbarRow = ".headerRow"

    // Act
    const wrapping = declarationOf(toolbarRow, "flex-wrap")

    // Assert
    const expected = "wrap"
    expect(wrapping).toBe(expected)
  })
})
