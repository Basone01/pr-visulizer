import type { ChangedSymbol } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { createNodeLibSource } from "../src/node.js"
import { mergePreciseEdges } from "../src/services/analysis/precise/mergePreciseEdges.js"
import { resolvePrecisionPolicy } from "../src/services/analysis/precise/policy.js"
import { createTsReferenceIndex } from "../src/services/analysis/precise/tsLanguageService.js"
import { buildAliasTable } from "../src/utils/tsconfigPaths.js"

// The real `typescript` LanguageService over a VIRTUAL host — no filesystem, no child process,
// no LSP server. What it must prove: it resolves references tree-sitter NAME resolution
// structurally cannot see (a type-directed method call), and it honours the engine's own
// alias resolver rather than re-deriving tsconfig semantics.

const TSCONFIG = `{
  // absolute imports
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } },
}`

const PATHS = {
  service: "src/service.ts",
  factory: "src/factory.ts",
  caller: "src/caller.ts",
  widget: "src/Widget.tsx",
} as const

// `caller.ts` never names `Service`. It calls `make()` and then `.doThing()` on the result —
// only TYPE INFERENCE links that call to `Service.doThing`.
const REPO: Record<string, string> = {
  "tsconfig.json": TSCONFIG,
  [PATHS.service]: `export class Service {\n  doThing() {\n    return 1\n  }\n}\n`,
  [PATHS.factory]: `import { Service } from "./service"\nexport function make() {\n  return new Service()\n}\n`,
  [PATHS.caller]: `import { make } from "@/factory"\nexport function start() {\n  const s = make()\n  return s.doThing()\n}\n`,
  [PATHS.widget]: `import { make } from "@/factory"\nexport function Widget() {\n  return <div>{make().doThing()}</div>\n}\n`,
}

const doThing: ChangedSymbol = {
  id: `${PATHS.service}#doThing`,
  path: PATHS.service,
  name: "doThing",
  kind: "method",
  span: { startLine: 2, endLine: 4 },
  changeKind: "modified",
}

const start: ChangedSymbol = {
  id: `${PATHS.caller}#start`,
  path: PATHS.caller,
  name: "start",
  kind: "function",
  span: { startLine: 2, endLine: 5 },
  changeKind: "modified",
}

const widget: ChangedSymbol = {
  id: `${PATHS.widget}#Widget`,
  path: PATHS.widget,
  name: "Widget",
  kind: "function",
  span: { startLine: 2, endLine: 4 },
  changeKind: "modified",
}

const contents = new Map(Object.entries(REPO))
const symbols = [doThing, start, widget]

async function buildIndex() {
  const index = await createTsReferenceIndex({
    contents,
    symbols,
    aliases: buildAliasTable(contents),
    libSource: createNodeLibSource(),
    policy: resolvePrecisionPolicy("balanced"),
  })
  if (!index) throw new Error("expected a reference index")

  return index
}

describe("createTsReferenceIndex — precision tree-sitter cannot reach", () => {
  it("resolves a type-directed method call through a factory's inferred return type", async () => {
    // Arrange — nothing in caller.ts names `Service`.
    const index = await buildIndex()
    const queried = [doThing.id]

    // Act
    const references = await index.referencesTo(queried)
    const callers = references
      .filter((reference) => reference.path !== PATHS.service)
      .map((reference) => reference.path)
      .sort()

    // Assert — both call sites found, through inference alone.
    const expectedCallers = [PATHS.widget, PATHS.caller].sort()
    expect(callers).toEqual(expectedCallers)
    expect(references.every((reference) => reference.kind === "calls")).toBe(true)
  })

  it("follows the engine's @/ alias resolver, not a re-derived tsconfig", async () => {
    // Arrange — caller.ts and Widget.tsx import "@/factory"; without the alias table the
    // program cannot see `make` at all and no reference to doThing would resolve.
    const withoutAliases = await createTsReferenceIndex({
      contents,
      symbols,
      aliases: [],
      libSource: createNodeLibSource(),
      policy: resolvePrecisionPolicy("balanced"),
    })
    if (!withoutAliases) throw new Error("expected an index")

    // Act
    const withAliases = await (await buildIndex()).referencesTo([doThing.id])
    const noAliases = await withoutAliases.referencesTo([doThing.id])

    // Assert — the alias table is what carries the cross-file references.
    expect(withAliases.length).toBeGreaterThan(noAliases.length)
    expect(noAliases.some((reference) => reference.path === PATHS.caller)).toBe(false)
  })
})

describe("createTsReferenceIndex — feeding the merge", () => {
  it("produces lsp edges the AST tier never had", async () => {
    // Arrange
    const index = await buildIndex()
    const astResult = {
      engine: "deep" as const,
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
      symbols,
      edges: [],
      ranking: [],
      ghosts: [],
      occurrences: [],
    }

    // Act
    const references = await index.referencesTo(symbols.map((symbol) => symbol.id))
    const { result, stats } = mergePreciseEdges(astResult, references)

    // Assert — start and Widget both call Service.doThing; every new edge is tagged lsp.
    const symbolEdges = result.edges
      .filter((edge) => edge.level === "symbol")
      .map((edge) => `${edge.from} -> ${edge.to}`)
      .sort()
    const expectedSymbolEdges = [
      `${start.id} -> ${doThing.id}`,
      `${widget.id} -> ${doThing.id}`,
    ].sort()

    expect(symbolEdges).toEqual(expectedSymbolEdges)
    expect(result.edges.every((edge) => edge.source === "lsp")).toBe(true)
    expect(stats.confirmed).toBe(0)
  })
})

describe("createTsReferenceIndex — policy bounds", () => {
  it("queries at most maxSymbols", async () => {
    // Arrange — a cap of one means only the first symbol is ever queried.
    const index = await createTsReferenceIndex({
      contents,
      symbols,
      aliases: buildAliasTable(contents),
      libSource: createNodeLibSource(),
      policy: resolvePrecisionPolicy("balanced", { maxSymbols: 1 }),
    })
    if (!index) throw new Error("expected an index")
    const queried = [start.id, doThing.id]

    // Act
    const references = await index.referencesTo(queried)

    // Assert — only `start`'s references, never doThing's.
    expect(references.every((reference) => reference.symbolId === start.id)).toBe(true)
  })

  it("returns null when no lib is available, so the caller keeps the AST result", async () => {
    // Arrange
    const emptyLibSource = () => Promise.resolve(undefined)

    // Act
    const index = await createTsReferenceIndex({
      contents,
      symbols,
      aliases: buildAliasTable(contents),
      libSource: emptyLibSource,
      policy: resolvePrecisionPolicy("balanced"),
    })

    // Assert
    expect(index).toBeNull()
  })
})

// Slice-3 wiring: the tier reached through the real pipeline entry point, both ways.
describe("analyzeDeepFromSources — precision tier wiring", () => {
  const prMeta = {
    owner: "acme",
    repo: "web",
    number: 1,
    title: "t",
    author: "octocat",
    baseSha: "base01",
    headSha: "head01",
  }
  const changedFiles = [PATHS.service, PATHS.factory, PATHS.caller].map((path) => ({
    path,
    status: "added" as const,
    additions: 5,
    deletions: 0,
    language: null,
    patch: null,
  }))

  async function analyze(precisionEnabled: boolean) {
    const { analyzeDeepFromSources } = await import("../src/services/analysis/analyzeDeepSources.js")
    const { createNodeGrammarSource } = await import("../src/node.js")

    return analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles,
      contents,
      grammarSource: createNodeGrammarSource(),
      ...(precisionEnabled
        ? {
            precision: {
              policy: resolvePrecisionPolicy("balanced"),
              libSource: createNodeLibSource(),
            },
          }
        : {}),
    })
  }

  it("adds lsp edges the ast tier could not see, and keeps every ast edge", async () => {
    // Arrange / Act
    const astOnly = await analyze(false)
    const withPrecision = await analyze(true)

    // Assert — no lsp edge without the tier; with it, the type-directed call appears and every
    // ast edge survives (deep can only add).
    const preciseCall = `${PATHS.caller}#start -> ${PATHS.service}#doThing`
    const edgeId = (edge: { from: string; to: string }) => `${edge.from} -> ${edge.to}`
    const astEdgeIds = astOnly.edges.map(edgeId)
    const mergedEdgeIds = withPrecision.edges.map(edgeId)

    expect(astOnly.edges.some((edge) => edge.source === "lsp")).toBe(false)
    expect(astEdgeIds.includes(preciseCall)).toBe(false)
    expect(mergedEdgeIds).toEqual(expect.arrayContaining(astEdgeIds))
    expect(mergedEdgeIds).toContain(preciseCall)
    expect(withPrecision.edges.some((edge) => edge.source === "lsp")).toBe(true)
  })

  it("keeps the ast result when the tier cannot build (no lib available)", async () => {
    // Arrange
    const { analyzeDeepFromSources } = await import("../src/services/analysis/analyzeDeepSources.js")
    const { createNodeGrammarSource } = await import("../src/node.js")
    const brokenLibSource = () => Promise.resolve(undefined)

    // Act
    const degraded = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles,
      contents,
      grammarSource: createNodeGrammarSource(),
      precision: { policy: resolvePrecisionPolicy("balanced"), libSource: brokenLibSource },
    })
    const astOnly = await analyze(false)

    // Assert — degrade, never fail: identical to the ast result.
    expect(degraded.edges).toEqual(astOnly.edges)
  })
})
