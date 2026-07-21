import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { GhostGroupNode } from "./GhostGroupNode"

// React Flow hands a custom node type only `data`; the rest of NodeProps is unused here, so the
// test drives the component the same narrow way the graph does.
function renderGroup(ghostCount: number) {
  const props = { data: { ghostCount } } as Parameters<typeof GhostGroupNode>[0]

  return render(<GhostGroupNode {...props} />)
}

describe("GhostGroupNode", () => {
  it("names the band as context and counts the files it holds", () => {
    // Arrange
    const ghostCount = 4

    // Act
    renderGroup(ghostCount)

    // Assert — the wording is the whole point: this region is not part of the review queue.
    const expectedLabel = "👻 context · not in review · 4 unchanged files"
    expect(screen.getByText(expectedLabel)).toBeInTheDocument()
  })

  it("says 'file' in the singular when the band holds exactly one ghost", () => {
    // Arrange
    const ghostCount = 1

    // Act
    renderGroup(ghostCount)

    // Assert
    const expectedLabel = "👻 context · not in review · 1 unchanged file"
    expect(screen.getByText(expectedLabel)).toBeInTheDocument()
  })
})
