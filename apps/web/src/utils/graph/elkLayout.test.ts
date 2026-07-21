import { describe, expect, it } from "vitest"

import { GHOST_NODE_HEIGHT, NODE_HEIGHT, NODE_WIDTH, buildElkGraph, nodeSize } from "./elkLayout"

// The reserved node box must match what FileNode/GhostNode actually render, or a taller node
// (symbols row, blast-radius badge) spills past its slot and its badge is covered by the node
// below. These lock the declared size to each content variant.
describe("nodeSize", () => {
  it("reserves only the base height for a plain node (no optional rows)", () => {
    // Arrange
    const plainNode = { hasSymbols: false, hasBlast: false }

    // Act
    const size = nodeSize(plainNode)

    // Assert
    const expected = { width: NODE_WIDTH, height: NODE_HEIGHT }
    expect(size).toEqual(expected)
  })

  it("reserves extra height for the changed-symbol chips row", () => {
    // Arrange
    const nodeWithSymbols = { hasSymbols: true, hasBlast: false }

    // Act
    const size = nodeSize(nodeWithSymbols)

    // Assert — taller than the base so the symbols row cannot overlap the node below.
    expect(size.width).toBe(NODE_WIDTH)
    expect(size.height).toBeGreaterThan(NODE_HEIGHT)
  })

  it("reserves the most height for a node with BOTH the symbols row and the blast badge", () => {
    // Arrange
    const symbolsOnly = { hasSymbols: true, hasBlast: false }
    const blastOnly = { hasSymbols: false, hasBlast: true }
    const symbolsAndBlast = { hasSymbols: true, hasBlast: true }

    // Act
    const heightSymbols = nodeSize(symbolsOnly).height
    const heightBlast = nodeSize(blastOnly).height
    const heightBoth = nodeSize(symbolsAndBlast).height

    // Assert — the reported worst case (symbols + blast) reserves both rows on top of the base.
    expect(heightBoth).toBeGreaterThan(heightSymbols)
    expect(heightBoth).toBeGreaterThan(heightBlast)
    expect(heightBoth).toBe(heightSymbols + (heightBlast - NODE_HEIGHT))
  })

  it("reserves the fixed ghost box and ignores the file-node row flags", () => {
    // Arrange — a ghost never shows a blast badge, so its flags must not change its size.
    const ghostNode = { ghost: true, hasSymbols: true, hasBlast: true }

    // Act
    const size = nodeSize(ghostNode)

    // Assert
    const expected = { width: NODE_WIDTH, height: GHOST_NODE_HEIGHT }
    expect(size).toEqual(expected)
  })
})

// buildElkGraph must hand elk the SAME per-node size, so the layout it computes matches the boxes
// React Flow later renders (both call nodeSize).
describe("buildElkGraph", () => {
  it("sizes each child from its content variant, not one fixed height", () => {
    // Arrange
    const plainPath = "src/plain.ts"
    const badgePath = "src/mapper.py"
    const nodes = [{ path: plainPath }, { path: badgePath, hasSymbols: true, hasBlast: true }]
    const edges = [{ from: badgePath, to: plainPath }]

    // Act
    const graph = buildElkGraph(nodes, edges)

    // Assert — the badge node reserves more vertical room than the plain node.
    const children = graph.children ?? []
    const plain = children.find((child) => child.id === plainPath)
    const badge = children.find((child) => child.id === badgePath)

    const expectedPlainHeight = NODE_HEIGHT
    expect(plain?.height).toBe(expectedPlainHeight)
    expect(badge?.height).toBeGreaterThan(expectedPlainHeight)
    expect(plain?.width).toBe(NODE_WIDTH)
  })

  // Ghosts are placed by ghostGroupLayout in their own band. If one reached elk it would land in
  // the first column among the isolated CHANGED files — the interleaving the band exists to fix.
  it("keeps ghosts out of the layered layout entirely", () => {
    // Arrange
    const foundationPath = "src/plain.ts"
    const dependentPath = "src/mapper.py"
    const ghostPath = "src/ghost.ts"
    const nodes = [
      { path: foundationPath },
      { path: dependentPath },
      { path: ghostPath, ghost: true },
    ]
    const edges = [{ from: dependentPath, to: foundationPath }]

    // Act
    const graph = buildElkGraph(nodes, edges)

    // Assert — only the changed files are handed to elk.
    const expectedIds = [foundationPath, dependentPath]
    expect((graph.children ?? []).map((child) => child.id)).toEqual(expectedIds)
  })

  // No engine emits a ghost edge today (a file edge needs BOTH endpoints changed), but an edge
  // naming a node elk was never given makes elk throw — so the filter drops those too.
  it("drops an edge whose endpoint is a ghost, so elk never sees an unknown node", () => {
    // Arrange
    const changedPath = "src/plain.ts"
    const ghostPath = "src/ghost.ts"
    const nodes = [{ path: changedPath }, { path: ghostPath, ghost: true }]
    const ghostEdge = { from: ghostPath, to: changedPath }

    // Act
    const graph = buildElkGraph(nodes, [ghostEdge])

    // Assert
    const expectedEdgeCount = 0
    expect(graph.edges ?? []).toHaveLength(expectedEdgeCount)
  })
})
