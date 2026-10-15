import { describe, expect, it } from "vitest"

import { renderMermaidSvg } from "./mermaidRenderer"

// Real mermaid, no mock. Only the rejection path runs here: jsdom has no SVG layout
// (`getBBox` is missing), so a successful render can only be checked in a real browser.

describe("renderMermaidSvg", () => {
  it("rejects_source_that_is_not_a_mermaid_diagram", async () => {
    // Arrange
    const source = "this is not a diagram"

    // Act
    const rendering = renderMermaidSvg(source)

    // Assert
    const expected = "No diagram type detected"
    await expect(rendering).rejects.toThrow(expected)
  })
})
