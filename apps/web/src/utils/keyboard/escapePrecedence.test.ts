import { describe, expect, it } from "vitest"

import { type EscapeLayer, pickEscapeOwner } from "./escapePrecedence"

// The pure half of the Escape fix: which of the open surfaces owns one keypress. Every claim
// carries an id so the assertions read as "this exact claim won", not just "some claim of that
// layer won".
type TestClaim = {
  id: string
  layer: EscapeLayer
}

describe("pickEscapeOwner", () => {
  it("gives the key to the innermost open layer", () => {
    // Arrange — the find-bar case from the bug report: the bar is open over a diff whose pane
    // collapse and jump stack are both live.
    const findBar: TestClaim = { id: "find", layer: "findBar" }
    const peek: TestClaim = { id: "peek", layer: "peek" }
    const paneCollapse: TestClaim = { id: "shell", layer: "paneCollapse" }

    // Act
    const owner = pickEscapeOwner([paneCollapse, peek, findBar])

    // Assert
    const expected = findBar
    expect(owner).toBe(expected)
  })

  it("ignores registration order — precedence is the table, not who registered first", () => {
    // Arrange
    const lineSelection: TestClaim = { id: "selection", layer: "lineSelection" }
    const descriptionPanel: TestClaim = { id: "sheet", layer: "descriptionPanel" }

    // Act
    const owner = pickEscapeOwner([lineSelection, descriptionPanel])

    // Assert
    const expected = descriptionPanel
    expect(owner).toBe(expected)
  })

  it("breaks a tie within one layer in favour of the claim registered last", () => {
    // Arrange — two instances of the same surface: the second to mount is the inner one.
    const outerPicker: TestClaim = { id: "outer", layer: "commitPicker" }
    const innerPicker: TestClaim = { id: "inner", layer: "commitPicker" }

    // Act
    const owner = pickEscapeOwner([outerPicker, innerPicker])

    // Assert
    const expected = innerPicker
    expect(owner).toBe(expected)
  })

  it("returns null when nothing is claiming Escape", () => {
    // Arrange
    const noClaims: TestClaim[] = []

    // Act
    const owner = pickEscapeOwner(noClaims)

    // Assert
    const expected = null
    expect(owner).toBe(expected)
  })
})
