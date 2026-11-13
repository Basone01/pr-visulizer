import { describe, expect, it } from "vitest"

import { type FlowDiagram, type RawFlowDiagram, normalizeFlowDiagram } from "./flowDiagram"

function rawDiagram(overrides: Partial<RawFlowDiagram>): RawFlowDiagram {
  return { title: "Queue rollout", nodes: [], edges: [], groups: [], ...overrides }
}

describe("normalizeFlowDiagram keeps what the agent sent", () => {
  it("reads nodes, edges and groups with their change, note, path and kind", () => {
    // Arrange
    const raw = rawDiagram({
      nodes: [
        {
          id: "api",
          label: "API",
          change: "changed",
          note: "direct dispatch → enqueue",
          path: "src/api.ts",
        },
        { id: "queue", label: "Job queue", change: "added", kind: "store" },
      ],
      edges: [{ from: "api", to: "queue", label: "enqueue", change: "added" }],
      groups: [{ label: "Backend", nodeIds: ["api", "queue"] }],
    })

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    const expected: FlowDiagram = {
      title: "Queue rollout",
      nodes: [
        {
          id: "api",
          label: "API",
          change: "changed",
          note: "direct dispatch → enqueue",
          path: "src/api.ts",
          line: null,
          kind: "component",
        },
        {
          id: "queue",
          label: "Job queue",
          change: "added",
          note: null,
          path: null,
          line: null,
          kind: "store",
        },
      ],
      edges: [{ id: "edge-0", from: "api", to: "queue", label: "enqueue", change: "added" }],
      groups: [{ id: "group-0", label: "Backend", nodeIds: ["api", "queue"] }],
      notices: [],
    }
    expect(diagram).toEqual(expected)
  })
})

describe("normalizeFlowDiagram tolerates model mistakes", () => {
  it("creates a plain node for an edge to an unknown id", () => {
    // Arrange
    const raw = rawDiagram({
      nodes: [{ id: "api", label: "API" }],
      edges: [{ from: "api", to: "billing" }],
    })

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    const implicitNode = diagram.nodes.find((node) => node.id === "billing")
    expect(implicitNode).toEqual({
      id: "billing",
      label: "billing",
      change: "unchanged",
      note: null,
      path: null,
      line: null,
      kind: "component",
    })
  })

  it("keeps the first node of a duplicate id and ignores missing group members", () => {
    // Arrange
    const raw = rawDiagram({
      nodes: [
        { id: "api", label: "First" },
        { id: "api", label: "Second" },
      ],
      groups: [{ label: "Backend", nodeIds: ["api", "ghost"] }],
    })

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    expect({
      labels: diagram.nodes.map((node) => node.label),
      group: diagram.groups[0]?.nodeIds,
    }).toEqual({ labels: ["First"], group: ["api"] })
  })

  it("falls back to the defaults for an unknown change or kind", () => {
    // Arrange
    const raw = rawDiagram({ nodes: [{ id: "api", change: "renamed", kind: "lambda" }] })

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    expect({ change: diagram.nodes[0]?.change, kind: diagram.nodes[0]?.kind }).toEqual({
      change: "unchanged",
      kind: "component",
    })
  })

  it("strips bidi controls from every string and keeps the full edge label", () => {
    // Arrange
    const raw = rawDiagram({
      nodes: [{ id: "a", label: "Ap‮i" }],
      edges: [{ from: "a", to: "a", label: "publishes events to" }],
    })

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    expect({ label: diagram.nodes[0]?.label, edgeLabel: diagram.edges[0]?.label }).toEqual({
      label: "Api",
      edgeLabel: "publishes events to",
    })
  })
})

describe("normalizeFlowDiagram says what it left out past the caps", () => {
  it("keeps the first 16 nodes and 24 edges and reports the totals", () => {
    // Arrange
    const nodeCount = 23
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({ id: `n${index}` }))
    const edges = Array.from({ length: 30 }, (_, index) => ({ from: "n0", to: `n${index % 10}` }))

    // Act
    const diagram = normalizeFlowDiagram(rawDiagram({ nodes, edges }))

    // Assert
    expect({
      nodes: diagram.nodes.length,
      edges: diagram.edges.length,
      notices: diagram.notices,
    }).toEqual({
      nodes: 16,
      edges: 24,
      notices: ["Showing 16 of 23 components", "Showing 24 of 30 relationships"],
    })
  })
})

describe("normalizeFlowDiagram draws no box an edge past the cap would have made", () => {
  it("creates no node for an unknown endpoint named only by edges past the edge cap", () => {
    // Arrange
    const edgeCap = 24
    const edgesInsideCap = Array.from({ length: edgeCap }, () => ({ from: "a", to: "b" }))
    const raw = rawDiagram({
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [...edgesInsideCap, { from: "a", to: "x" }, { from: "a", to: "y" }],
    })

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    const expected = ["a", "b"]
    expect(diagram.nodes.map((node) => node.id)).toEqual(expected)
  })
})
