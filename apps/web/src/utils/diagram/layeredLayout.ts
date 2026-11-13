import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api"

import type { LayoutDirection } from "./layoutDirection"
import type { Point } from "./orthogonalPath"

// A generic boxes-and-arrows layout on elkjs' layered algorithm: boxes, optional containers
// (one level), and directed edges with an optional label. Pure: this module shapes the graph and
// reads the answer back. Running elk is CPU work, so it goes through an injected runner (the web
// worker in the app, elk in-process in tests).
//
// Coordinates come back absolute: `elk.json.shapeCoords` and `elk.json.edgeCoords` set to ROOT
// (verified on elkjs 0.11.1: without them, node x/y are parent-relative and edge sections are
// relative to the edge's container).

export type LayeredBox = { id: string; width: number; height: number; containerId: string | null }

export type LayeredContainer = { id: string; headerHeight: number }

export type LayeredEdge = {
  id: string
  from: string
  to: string
  // elk's layered algorithm skips a label with empty text: no space reserved, left at the
  // container's origin (verified on elkjs 0.11.1), so the text must come along with the size.
  label: { text: string; width: number; height: number } | null
}

export type LayeredGraph = {
  boxes: LayeredBox[]
  containers: LayeredContainer[]
  edges: LayeredEdge[]
}

export type Rect = { x: number; y: number; width: number; height: number }

export type PlacedEdge = { points: Point[]; label: Rect | null }

export type LayeredLayout = {
  width: number
  height: number
  boxes: Map<string, Rect>
  containers: Map<string, Rect>
  edges: Map<string, PlacedEdge>
}

export type ElkRunner = (graph: ElkNode, signal?: AbortSignal) => Promise<ElkNode>

const CONTAINER_PADDING = 12
// The block around the diagram has its own padding, so this only keeps room for a node's
// corner badge (radius 8, plus its stroke) at the diagram's edge.
const OUTER_PADDING = 9

// elk sees only ids made from list positions ("b0", "c0", "e0"), never the caller's ids: the
// caller's ids come from agent output, and one that matched another object's id (a node named
// like a group) would make elk merge or misfile the two. readLayeredLayout maps them back.
const elkBoxId = (index: number): string => `b${index}`
const elkContainerId = (index: number): string => `c${index}`
const elkEdgeId = (index: number): string => `e${index}`

export function buildLayeredElkGraph(graph: LayeredGraph, direction: LayoutDirection): ElkNode {
  const boxIdOf = new Map(graph.boxes.map((box, index) => [box.id, elkBoxId(index)]))
  const containerIdOf = new Map(
    graph.containers.map((container, index) => [container.id, elkContainerId(index)])
  )

  const boxesIn = (containerId: string | null): ElkNode[] =>
    graph.boxes.flatMap((box, index) =>
      box.containerId === containerId
        ? [{ id: elkBoxId(index), width: box.width, height: box.height }]
        : []
    )

  const containers: ElkNode[] = graph.containers.map((container, index) => ({
    id: elkContainerId(index),
    layoutOptions: {
      "elk.padding": `[top=${container.headerHeight},left=${CONTAINER_PADDING},bottom=${CONTAINER_PADDING},right=${CONTAINER_PADDING}]`,
    },
    children: boxesIn(container.id),
  }))
  const freeBoxes = graph.boxes.flatMap((box, index) =>
    box.containerId === null || !containerIdOf.has(box.containerId)
      ? [{ id: elkBoxId(index), width: box.width, height: box.height }]
      : []
  )

  const edges: ElkExtendedEdge[] = graph.edges.flatMap((edge, index) => {
    const source = boxIdOf.get(edge.from)
    const target = boxIdOf.get(edge.to)
    if (!source || !target) return []

    return [
      {
        id: elkEdgeId(index),
        sources: [source],
        targets: [target],
        ...(edge.label
          ? {
              labels: [
                {
                  id: `${elkEdgeId(index)}-label`,
                  text: edge.label.text,
                  width: edge.label.width,
                  height: edge.label.height,
                },
              ],
            }
          : {}),
      },
    ]
  })

  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.padding": `[top=${OUTER_PADDING},left=${OUTER_PADDING},bottom=${OUTER_PADDING},right=${OUTER_PADDING}]`,
      // Tight enough that a six-node flow fits the default 330 px chat block at 80% or more.
      "elk.spacing.nodeNode": "16",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.edgeNode": "12",
      "elk.spacing.edgeEdge": "8",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
    },
    children: [...containers, ...freeBoxes],
    edges,
  }
}

export function readLayeredLayout(laidOut: ElkNode, graph: LayeredGraph): LayeredLayout {
  const boxIdOf = new Map(graph.boxes.map((box, index) => [elkBoxId(index), box.id]))
  const containerIdOf = new Map(
    graph.containers.map((container, index) => [elkContainerId(index), container.id])
  )
  const edgeIdOf = new Map(graph.edges.map((edge, index) => [elkEdgeId(index), edge.id]))
  const boxes = new Map<string, Rect>()
  const containers = new Map<string, Rect>()

  const visit = (node: ElkNode): void => {
    for (const child of node.children ?? []) {
      const boxId = boxIdOf.get(child.id)
      const containerId = containerIdOf.get(child.id)
      if (boxId !== undefined) boxes.set(boxId, rectOf(child))
      if (containerId !== undefined) containers.set(containerId, rectOf(child))
      visit(child)
    }
  }
  visit(laidOut)

  const edges = new Map<string, PlacedEdge>()
  for (const edge of laidOut.edges ?? []) {
    const edgeId = edgeIdOf.get(edge.id)
    if (edgeId !== undefined) edges.set(edgeId, placedEdge(edge))
  }

  return { width: laidOut.width ?? 0, height: laidOut.height ?? 0, boxes, containers, edges }
}

function rectOf(node: ElkNode): Rect {
  return { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 }
}

// One section per edge for a simple (non-hyperedge) graph: start, bends, end.
function placedEdge(edge: ElkExtendedEdge): PlacedEdge {
  const points = (edge.sections ?? []).flatMap((section) => [
    section.startPoint,
    ...(section.bendPoints ?? []),
    section.endPoint,
  ])
  const label = edge.labels?.[0]

  return {
    points: points.map(({ x, y }) => ({ x, y })),
    label: label ? rectOf(label as ElkNode) : null,
  }
}

export async function computeLayeredLayout(
  graph: LayeredGraph,
  direction: LayoutDirection,
  run: ElkRunner,
  signal?: AbortSignal
): Promise<LayeredLayout> {
  const laidOut = await run(buildLayeredElkGraph(graph, direction), signal)
  return readLayeredLayout(laidOut, graph)
}
