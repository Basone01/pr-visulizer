import ELK from "elkjs/lib/elk.bundled.js"
import { describe, expect, it } from "vitest"

import { type ElkRunner, type LayeredGraph, type Rect, computeLayeredLayout } from "./layeredLayout"
import type { LayoutDirection } from "./layoutDirection"
import type { Point } from "./orthogonalPath"

// Real elk, in the test process: the geometry promises hold for what elk actually returns.
const runElkInProcess: ElkRunner = (graph) => new ELK().layout(graph)

// Two groups and a free node, with edges that cross group borders, two with a label.
const GRAPH: LayeredGraph = {
  boxes: [
    { id: "api", width: 160, height: 48, containerId: "backend" },
    { id: "queue", width: 160, height: 56, containerId: "backend" },
    { id: "worker", width: 160, height: 48, containerId: "jobs" },
    { id: "mailer", width: 160, height: 40, containerId: "jobs" },
    { id: "ui", width: 160, height: 48, containerId: null },
  ],
  containers: [
    { id: "backend", headerHeight: 28 },
    { id: "jobs", headerHeight: 28 },
  ],
  edges: [
    { id: "e0", from: "ui", to: "api", label: { text: "POST", width: 56, height: 16 } },
    { id: "e1", from: "api", to: "queue", label: { text: "ENQUEUE", width: 64, height: 16 } },
    { id: "e2", from: "queue", to: "worker", label: null },
    { id: "e3", from: "worker", to: "mailer", label: null },
    { id: "e4", from: "api", to: "mailer", label: null },
  ],
}

const MEMBERS: Record<string, string[]> = { backend: ["api", "queue"], jobs: ["worker", "mailer"] }

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

const BORDER_TOLERANCE = 0.5
// How far a label may sit from its edge: elk keeps `elk.spacing.edgeLabel` (4) between them.
const LABEL_REACH = 8

function segmentRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function grow(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  }
}

// Touching counts: a horizontal segment has height 0.
function touches(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  )
}

function onBorder(point: Point, rect: Rect): boolean {
  const withinX =
    point.x >= rect.x - BORDER_TOLERANCE && point.x <= rect.x + rect.width + BORDER_TOLERANCE
  const withinY =
    point.y >= rect.y - BORDER_TOLERANCE && point.y <= rect.y + rect.height + BORDER_TOLERANCE
  const onVertical =
    Math.abs(point.x - rect.x) <= BORDER_TOLERANCE ||
    Math.abs(point.x - (rect.x + rect.width)) <= BORDER_TOLERANCE
  const onHorizontal =
    Math.abs(point.y - rect.y) <= BORDER_TOLERANCE ||
    Math.abs(point.y - (rect.y + rect.height)) <= BORDER_TOLERANCE

  return (onVertical && withinY) || (onHorizontal && withinX)
}

describe.each<LayoutDirection>(["down", "right"])("real elk layout, direction %s", (direction) => {
  it("places no two nodes on top of each other", async () => {
    // Arrange
    const graph = GRAPH

    // Act
    const layout = await computeLayeredLayout(graph, direction, runElkInProcess)

    // Assert
    const rects = [...layout.boxes.values()]
    const overlappingPairs = rects.flatMap((a, i) =>
      rects.slice(i + 1).filter((b) => overlaps(a, b))
    )
    expect({ placed: rects.length, overlappingPairs: overlappingPairs.length }).toEqual({
      placed: 5,
      overlappingPairs: 0,
    })
  })

  it("places every node inside its group", async () => {
    // Arrange
    const graph = GRAPH

    // Act
    const layout = await computeLayeredLayout(graph, direction, runElkInProcess)

    // Assert
    const outside = Object.entries(MEMBERS).flatMap(([groupId, nodeIds]) =>
      nodeIds.filter((nodeId) => {
        const group = layout.containers.get(groupId)
        const node = layout.boxes.get(nodeId)
        return !group || !node || !contains(group, node)
      })
    )
    expect(outside).toEqual([])
  })

  it("starts and ends every edge on its endpoints' borders", async () => {
    // Arrange
    const graph = GRAPH

    // Act
    const layout = await computeLayeredLayout(graph, direction, runElkInProcess)

    // Assert
    const misplaced = graph.edges.filter((edge) => {
      const points = layout.edges.get(edge.id)?.points ?? []
      const first = points[0]
      const last = points[points.length - 1]
      const source = layout.boxes.get(edge.from)
      const target = layout.boxes.get(edge.to)
      return (
        !first || !last || !source || !target || !onBorder(first, source) || !onBorder(last, target)
      )
    })
    expect(misplaced.map((edge) => edge.id)).toEqual([])
  })

  it("routes every edge with orthogonal segments only", async () => {
    // Arrange
    const graph = GRAPH

    // Act
    const layout = await computeLayeredLayout(graph, direction, runElkInProcess)

    // Assert
    const diagonalSegments = [...layout.edges.values()].flatMap(({ points }) =>
      points.slice(1).filter((point, index) => {
        const previous = points[index] as Point
        return point.x !== previous.x && point.y !== previous.y
      })
    )
    expect(diagonalSegments).toEqual([])
  })

  it("places every edge label beside its own edge, clear of the nodes", async () => {
    // Arrange
    const graph = GRAPH

    // Act
    const layout = await computeLayeredLayout(graph, direction, runElkInProcess)

    // Assert
    const misplacedLabels = [...layout.edges.entries()].flatMap(([edgeId, { points, label }]) => {
      if (label === null) return []

      const reach = grow(label, LABEL_REACH)
      const isBesideEdge = points
        .slice(1)
        .some((point, index) => touches(reach, segmentRect(points[index] as Point, point)))
      const coversNode = [...layout.boxes.values()].some((box) => overlaps(label, box))
      return isBesideEdge && !coversNode ? [] : [edgeId]
    })
    expect(misplacedLabels).toEqual([])
  })
})

describe("layout ids the caller chose cannot collide with each other", () => {
  it("places a box whose id equals a container's id as a box, with the container around its own members", async () => {
    // Arrange
    const graph: LayeredGraph = {
      boxes: [
        { id: "a", width: 96, height: 40, containerId: "group-0" },
        { id: "b", width: 96, height: 40, containerId: "group-0" },
        { id: "group-0", width: 96, height: 40, containerId: null },
      ],
      containers: [{ id: "group-0", headerHeight: 28 }],
      edges: [
        { id: "edge-0", from: "a", to: "b", label: null },
        { id: "edge-1", from: "b", to: "group-0", label: null },
      ],
    }

    // Act
    const layout = await computeLayeredLayout(graph, "down", runElkInProcess)

    // Assert
    const zone = layout.containers.get("group-0")
    const box = layout.boxes.get("group-0")
    expect({
      boxIsPlaced: box !== undefined,
      zoneHoldsMembers:
        zone !== undefined &&
        ["a", "b"].every((id) => {
          const member = layout.boxes.get(id)
          return member !== undefined && contains(zone, member)
        }),
      boxIsOutsideZone: zone !== undefined && box !== undefined && !overlaps(zone, box),
    }).toEqual({ boxIsPlaced: true, zoneHoldsMembers: true, boxIsOutsideZone: true })
  })
})
