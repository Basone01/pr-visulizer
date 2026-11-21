import { describe, expect, it } from "vitest"

import { declarationOf } from "@/test/cssDeclaration"

import stylesheet from "./Diff.module.css?raw"

describe("diff pane toolbar", () => {
  it("diff toolbar wraps inside a narrow diff pane instead of leaving it", () => {
    // Arrange
    const toolbarRow = ".headerRow"

    // Act
    const wrapping = declarationOf(stylesheet, toolbarRow, "flex-wrap")

    // Assert
    const expected = "wrap"
    expect(wrapping).toBe(expected)
  })
})
