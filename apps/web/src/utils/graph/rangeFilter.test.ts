import type { Edge } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import type { FileNodeVM } from "@/entity/viewModels"

import { rangeVisibleGraph } from "./rangeFilter"

// The graph's half of the commit-range lens (§10): the same narrowing the review tray applies,
// so the two panes can never disagree about what the selected commits touched.

const LIMITS_PATH = "src/config/limits.ts"
const RATE_LIMITER_PATH = "src/lib/rateLimiter.ts"
const LOGIN_PATH = "src/api/routes/login.ts"

function fileNode(path: string, order: number): FileNodeVM {
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    status: "modified",
    order,
    topoLevel: 0,
    additions: 4,
    deletions: 0,
    fanIn: 0,
    blastRadius: null,
    symbols: [],
    reviewed: false,
    isNext: false,
  }
}

function fileEdge(from: string, to: string): Edge {
  return { from, to, kind: "imports", level: "file", source: "ast" }
}

const fileNodes: FileNodeVM[] = [
  fileNode(LIMITS_PATH, 1),
  fileNode(RATE_LIMITER_PATH, 2),
  fileNode(LOGIN_PATH, 3),
]

// rateLimiter → limits stays INSIDE a range that holds both; login → rateLimiter CROSSES the
// boundary when login is filtered out. The symbol-level edge must never reach the graph at all.
const edges: Edge[] = [
  fileEdge(RATE_LIMITER_PATH, LIMITS_PATH),
  fileEdge(LOGIN_PATH, RATE_LIMITER_PATH),
  { ...fileEdge(LOGIN_PATH, LIMITS_PATH), level: "symbol" },
]

describe("rangeVisibleGraph — no commit range", () => {
  it("returns the whole PR, with the symbol-level edge still excluded", () => {
    // Arrange
    const noRange = null

    // Act
    const visible = rangeVisibleGraph(fileNodes, edges, noRange)

    // Assert — every node, and only the two FILE-level edges.
    const expected = {
      paths: [LIMITS_PATH, RATE_LIMITER_PATH, LOGIN_PATH],
      edges: [`${RATE_LIMITER_PATH}->${LIMITS_PATH}`, `${LOGIN_PATH}->${RATE_LIMITER_PATH}`],
    }
    expect({
      paths: visible.fileNodes.map((node) => node.path),
      edges: visible.fileEdges.map((edge) => `${edge.from}->${edge.to}`),
    }).toEqual(expected)
  })
})

describe("rangeVisibleGraph — a commit range is active", () => {
  it("keeps only the touched files, with their whole-PR order numbers", () => {
    // Arrange — the range skips the MIDDLE-ranked file, so a kept order number can't be
    // confused with a re-numbered position.
    const touchedPaths = new Set([LIMITS_PATH, LOGIN_PATH])

    // Act
    const visible = rangeVisibleGraph(fileNodes, edges, touchedPaths)

    // Assert — order 1 and 3, NOT renumbered to 1 and 2.
    const expected = [
      { path: LIMITS_PATH, order: 1 },
      { path: LOGIN_PATH, order: 3 },
    ]
    expect(visible.fileNodes.map((node) => ({ path: node.path, order: node.order }))).toEqual(
      expected
    )
  })

  it("drops an edge whose other endpoint the range filtered out", () => {
    // Arrange — login is out, so login→rateLimiter has nothing to draw to.
    const touchedPaths = new Set([LIMITS_PATH, RATE_LIMITER_PATH])

    // Act
    const visible = rangeVisibleGraph(fileNodes, edges, touchedPaths)

    // Assert — only the edge with BOTH endpoints on the canvas survives.
    const expected = [`${RATE_LIMITER_PATH}->${LIMITS_PATH}`]
    expect(visible.fileEdges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(expected)
  })

  it("reports the drawn paths, ignoring touched paths the graph has no node for", () => {
    // Arrange — a range can name a file the graph never had a node for (a pre-rename name).
    const renamedAwayPath = "src/lib/oldRateLimiterName.ts"
    const touchedPaths = new Set([LIMITS_PATH, renamedAwayPath])

    // Act
    const visible = rangeVisibleGraph(fileNodes, edges, touchedPaths)

    // Assert
    const expected = { drawn: [LIMITS_PATH], hasPhantom: false }
    expect({
      drawn: [...visible.paths],
      hasPhantom: visible.paths.has(renamedAwayPath),
    }).toEqual(expected)
  })

  it("empties the graph when the range touches none of its files", () => {
    // Arrange — an EMPTY set is a real range that touches nothing here, not "no range".
    const touchedPaths = new Set<string>()

    // Act
    const visible = rangeVisibleGraph(fileNodes, edges, touchedPaths)

    // Assert
    const expected = { nodeCount: 0, edgeCount: 0 }
    expect({
      nodeCount: visible.fileNodes.length,
      edgeCount: visible.fileEdges.length,
    }).toEqual(expected)
  })

  it("restores the whole graph when the range is cleared", () => {
    // Arrange — clearing hands back null, and nothing about the filtered pass may linger.
    const touchedPaths = new Set([LIMITS_PATH])
    rangeVisibleGraph(fileNodes, edges, touchedPaths)

    // Act
    const restored = rangeVisibleGraph(fileNodes, edges, null)

    // Assert
    const expected = { nodeCount: 3, edgeCount: 2 }
    expect({
      nodeCount: restored.fileNodes.length,
      edgeCount: restored.fileEdges.length,
    }).toEqual(expected)
  })
})
