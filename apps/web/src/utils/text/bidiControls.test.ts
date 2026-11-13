import { describe, expect, it } from "vitest"

import { stripBidiControls } from "./bidiControls"

describe("stripBidiControls removes characters that can reorder what follows", () => {
  it("strips every bidi control and keeps the visible text", () => {
    // Arrange
    const label = "Open ‮‪‫‬‭⁦⁧⁨⁩‎‏؜docs"

    // Act
    const stripped = stripBidiControls(label)

    // Assert
    const expected = "Open docs"
    expect(stripped).toBe(expected)
  })
})
