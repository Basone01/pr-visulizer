import type { AnalysisResult, ChangedSymbol, Edge } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { mergePreciseEdges } from "../src/services/analysis/precise/mergePreciseEdges.js"
import {
  type PreciseReference,
  createFakeReferenceIndex,
} from "../src/services/analysis/precise/referenceIndex.js"

// The precision tier's merge (docs/architecture.md §4.2). Driven entirely by the in-memory
// fake — no `typescript`, no language service — so a red test here is always the merge's
// fault. The invariant under test: **deep can only add**. An AST edge is confirmed (re-tagged
// `lsp`) or left alone; it is never removed, never re-pointed.

const SERVICE = "src/service.ts"
const CALLER = "src/caller.ts"
const GHOST = "src/unchanged.ts"

const doThing: ChangedSymbol = {
  id: `${SERVICE}#doThing`,
  path: SERVICE,
  name: "doThing",
  kind: "method",
  span: { startLine: 2, endLine: 4 },
  changeKind: "modified",
}

const start: ChangedSymbol = {
  id: `${CALLER}#start`,
  path: CALLER,
  name: "start",
  kind: "function",
  span: { startLine: 10, endLine: 20 },
  changeKind: "modified",
}

function analysisWith(edges: Edge[]): AnalysisResult {
  return {
    engine: "deep",
    pr: {
      owner: "acme",
      repo: "web",
      number: 1,
      title: "t",
      author: "octocat",
      baseSha: "base01",
      headSha: "head01",
    },
    files: [],
    symbols: [doThing, start],
    edges,
    ranking: [],
    ghosts: [],
    occurrences: [],
  }
}

const astSymbolEdge: Edge = {
  from: start.id,
  to: doThing.id,
  kind: "calls",
  level: "symbol",
  source: "ast",
}

// An AST edge the language service will NOT confirm (a name-resolution guess).
const astOnlyEdge: Edge = {
  from: start.id,
  to: `${SERVICE}#other`,
  kind: "uses",
  level: "symbol",
  source: "ast",
}

// `start` calls `doThing` at line 12 — inside start's span, so start is the container.
const callReference: PreciseReference = {
  symbolId: doThing.id,
  path: CALLER,
  line: 12,
  kind: "calls",
}

describe("mergePreciseEdges — confirming an AST edge", () => {
  it("re-tags a confirmed edge as lsp and keeps its position", () => {
    // Arrange
    const astResult = analysisWith([astOnlyEdge, astSymbolEdge])
    const references = [callReference]

    // Act
    const { result, stats } = mergePreciseEdges(astResult, references)

    // Assert — same edge, same slot, source flipped; the unconfirmed one untouched.
    const expectedSources = ["ast", "lsp"]
    const expectedStats = { confirmed: 1, added: 1, unchanged: 1 }
    expect(result.edges.slice(0, 2).map((edge) => edge.source)).toEqual(expectedSources)
    expect(result.edges[1]).toEqual({ ...astSymbolEdge, source: "lsp" })
    expect(stats).toEqual(expectedStats)
  })
})

describe("mergePreciseEdges — deep can only add", () => {
  it("never removes an AST edge when the language service returns nothing", () => {
    // Arrange — the service sees nothing at all (it failed, or timed out).
    const astResult = analysisWith([astSymbolEdge, astOnlyEdge])
    const noReferences: PreciseReference[] = []

    // Act
    const { result, stats } = mergePreciseEdges(astResult, noReferences)

    // Assert — byte-for-byte the input edges.
    const expectedStats = { confirmed: 0, added: 0, unchanged: 2 }
    expect(result.edges).toEqual([astSymbolEdge, astOnlyEdge])
    expect(stats).toEqual(expectedStats)
  })

  // The empty-references case above cannot catch a "deep REPLACES the ast result" bug — the
  // bug only fires once the service HAS something to say. This is that case: the service
  // confirms one edge and is silent about the other, which must survive as `ast`.
  it("keeps an unconfirmed AST edge alongside the confirmed one", () => {
    // Arrange
    const astResult = analysisWith([astSymbolEdge, astOnlyEdge])
    const references = [callReference] // confirms astSymbolEdge only

    // Act
    const { result } = mergePreciseEdges(astResult, references)

    // Assert — the unconfirmed edge is present, unmodified, still tagged `ast`.
    const expectedConfirmed = { ...astSymbolEdge, source: "lsp" }
    expect(result.edges).toContainEqual(astOnlyEdge)
    expect(result.edges).toContainEqual(expectedConfirmed)
  })

  it("adds a precise edge the AST tier never saw, tagged lsp", () => {
    // Arrange — a type-directed call: no AST edge exists for it at all.
    const astResult = analysisWith([])
    const references = [callReference]

    // Act
    const { result, stats } = mergePreciseEdges(astResult, references)

    // Assert — one symbol edge and the file edge beneath it, both lsp.
    const expectedSymbolEdge: Edge = {
      from: start.id,
      to: doThing.id,
      kind: "calls",
      level: "symbol",
      source: "lsp",
    }
    const expectedFileEdge: Edge = {
      from: CALLER,
      to: SERVICE,
      kind: "calls",
      level: "file",
      source: "lsp",
    }
    const expectedStats = { confirmed: 0, added: 2, unchanged: 0 }
    expect(result.edges).toEqual([expectedSymbolEdge, expectedFileEdge])
    expect(stats).toEqual(expectedStats)
  })

  it("leaves everything except edges untouched", () => {
    // Arrange
    const astResult = analysisWith([astSymbolEdge])
    const references = [callReference]

    // Act
    const { result } = mergePreciseEdges(astResult, references)

    // Assert — ranking, ghosts, symbols, occurrences are the AST tier's, unmodified.
    expect(result.symbols).toBe(astResult.symbols)
    expect(result.ranking).toBe(astResult.ranking)
    expect(result.ghosts).toBe(astResult.ghosts)
    expect(result.occurrences).toBe(astResult.occurrences)
  })
})

describe("mergePreciseEdges — an edge needs BOTH endpoints changed", () => {
  it("ignores a reference from an unchanged (ghost) file", () => {
    // Arrange — an unchanged file calls the changed symbol. Real context, but not an edge:
    // the AST tier already counts it in ghosts + blastRadius.
    const astResult = analysisWith([])
    const ghostReference: PreciseReference = {
      symbolId: doThing.id,
      path: GHOST,
      line: 5,
      kind: "calls",
    }

    // Act
    const { result, stats } = mergePreciseEdges(astResult, [ghostReference])

    // Assert
    const expectedStats = { confirmed: 0, added: 0, unchanged: 0 }
    expect(result.edges).toEqual([])
    expect(stats).toEqual(expectedStats)
  })

  it("ignores a self-reference inside the defining symbol", () => {
    // Arrange — recursion: doThing references itself at line 3, inside its own span.
    const astResult = analysisWith([])
    const selfReference: PreciseReference = {
      symbolId: doThing.id,
      path: SERVICE,
      line: 3,
      kind: "calls",
    }

    // Act
    const { result } = mergePreciseEdges(astResult, [selfReference])

    // Assert
    expect(result.edges).toEqual([])
  })
})

describe("mergePreciseEdges — deduplication", () => {
  it("collapses repeated references between the same pair into one edge", () => {
    // Arrange — start calls doThing three times.
    const astResult = analysisWith([])
    const lines = [11, 12, 13]
    const references = lines.map(
      (line): PreciseReference => ({ symbolId: doThing.id, path: CALLER, line, kind: "calls" })
    )

    // Act
    const { result, stats } = mergePreciseEdges(astResult, references)

    // Assert — one symbol edge + one file edge, not three of each.
    const expectedAdded = 2
    expect(stats.added).toBe(expectedAdded)
    expect(result.edges).toHaveLength(expectedAdded)
  })
})

describe("createFakeReferenceIndex", () => {
  it("returns only the references for the queried symbols", async () => {
    // Arrange
    const otherReference: PreciseReference = {
      symbolId: `${SERVICE}#unrelated`,
      path: CALLER,
      line: 12,
      kind: "uses",
    }
    const index = createFakeReferenceIndex([callReference, otherReference])
    const queried = [doThing.id]

    // Act
    const found = await index.referencesTo(queried)

    // Assert
    expect(found).toEqual([callReference])
  })
})
