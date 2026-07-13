import type { AnalysisResult, ChangedSymbol } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { createNodeGrammarSource, createNodeLibSource } from "../src/node.js"
import { analyzeDeepFromSources } from "../src/services/analysis/analyzeDeepSources.js"
import { mergePreciseEdges } from "../src/services/analysis/precise/mergePreciseEdges.js"
import { resolvePrecisionPolicy } from "../src/services/analysis/precise/policy.js"
import { createTsReferenceIndex } from "../src/services/analysis/precise/tsLanguageService.js"
import { buildAliasTable } from "../src/utils/tsconfigPaths.js"

// The deep-v2 tier must NEVER cost the analysis. Three ways it used to:
//   1. one Go symbol threw `Could not find source file` and killed every TS result with it
//   2. a Go-only PR loaded the ~9 MB compiler and a repo-wide program, to produce nothing
//   3. nothing capped the phase, so a hang was indistinguishable from a freeze
// Each is pinned below.

const CONFIG = "src/config.ts"
const USE = "src/use.ts"
const MAIN = "cmd/main.go"

const REPO: Record<string, string> = {
  [CONFIG]: `export const CONFIG = { title: "x" }\n`,
  [USE]: `import { CONFIG } from "./config"\nexport function read() {\n  return CONFIG.title\n}\n`,
  [MAIN]: `package main\n\nfunc Main() {\n\tprintln("hi")\n}\n`,
}

const contents = new Map(Object.entries(REPO))

const configSymbol: ChangedSymbol = {
  id: `${CONFIG}#CONFIG`,
  path: CONFIG,
  name: "CONFIG",
  kind: "const",
  span: { startLine: 1, endLine: 1 },
  changeKind: "modified",
}

const readSymbol: ChangedSymbol = {
  id: `${USE}#read`,
  path: USE,
  name: "read",
  kind: "function",
  span: { startLine: 2, endLine: 4 },
  changeKind: "modified",
}

const goSymbol: ChangedSymbol = {
  id: `${MAIN}#Main`,
  path: MAIN,
  name: "Main",
  kind: "function",
  span: { startLine: 3, endLine: 5 },
  changeKind: "modified",
}

const prMeta = {
  owner: "wisesight",
  repo: "analytics-suite",
  number: 1087,
  title: "mixed",
  author: "octocat",
  baseSha: "base01",
  headSha: "head01",
}

function changedFiles(paths: readonly string[]) {
  return paths.map((path) => ({
    path,
    status: "added" as const,
    additions: 5,
    deletions: 0,
    language: null,
    patch: null,
  }))
}

describe("precision tier — a Go symbol must not poison the TS symbols", () => {
  it("returns the TS references even when a Go symbol is queried alongside them", async () => {
    // Arrange — the exact mixed shape of a real Go+TS monorepo PR. Asking the TypeScript
    // program about `cmd/main.go` throws inside the compiler; that must cost only that symbol.
    const symbols = [goSymbol, configSymbol, readSymbol]
    const index = await createTsReferenceIndex({
      contents,
      symbols,
      aliases: buildAliasTable(contents),
      libSource: createNodeLibSource(),
      policy: resolvePrecisionPolicy("balanced"),
    })
    if (!index) throw new Error("expected an index")

    // Act — the Go symbol is FIRST, so a throw would discard everything after it.
    const references = await index.referencesTo(symbols.map((symbol) => symbol.id))

    // Assert — `read()` reads CONFIG, so CONFIG has a real cross-file reference.
    const referencedSymbols = [...new Set(references.map((reference) => reference.symbolId))]
    expect(referencedSymbols).toContain(configSymbol.id)
    expect(references.some((reference) => reference.path === USE)).toBe(true)
    // No reference is ever attributed to a Go symbol.
    expect(references.some((reference) => reference.symbolId === goSymbol.id)).toBe(false)
  })

  it("merges the surviving TS references into lsp edges", async () => {
    // Arrange
    const symbols = [goSymbol, configSymbol, readSymbol]

    // Act
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles([CONFIG, USE, MAIN]),
      contents,
      grammarSource: createNodeGrammarSource(),
      precision: {
        policy: resolvePrecisionPolicy("balanced"),
        libSource: createNodeLibSource(),
      },
    })

    // Assert — the tier produced compiler-grade edges despite the Go file in the PR.
    const expectedEdge = `${readSymbol.id} -> ${configSymbol.id}`
    const lspEdges = result.edges
      .filter((edge) => edge.source === "lsp")
      .map((edge) => `${edge.from} -> ${edge.to}`)

    expect(lspEdges).toContain(expectedEdge)
    expect(symbols.length).toBeGreaterThan(0)
  })
})

describe("precision tier — a Go-only PR skips the tier entirely", () => {
  it("builds no index when no changed symbol is a TS/JS file", async () => {
    // Arrange — the repo still contains TypeScript; only the CHANGED symbols are Go.
    const goOnly = [goSymbol]

    // Act
    const index = await createTsReferenceIndex({
      contents,
      symbols: goOnly,
      aliases: buildAliasTable(contents),
      libSource: createNodeLibSource(),
      policy: resolvePrecisionPolicy("balanced"),
    })

    // Assert — null means the caller keeps the AST result and never pays for a program.
    expect(index).toBeNull()
  })

  it("produces an ast-only analysis for a Go-only changed set", async () => {
    // Arrange / Act
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles([MAIN]),
      contents,
      grammarSource: createNodeGrammarSource(),
      precision: {
        policy: resolvePrecisionPolicy("balanced"),
        libSource: createNodeLibSource(),
      },
    })

    // Assert
    expect(result.edges.every((edge) => edge.source !== "lsp")).toBe(true)
  })
})

describe("precision tier — the phase has a hard ceiling", () => {
  it("keeps the ast result when the precise phase never settles", async () => {
    // Arrange — a libSource that hangs forever: the phase can never finish.
    const neverSettles = () => new Promise<string | undefined>(() => {})
    const phaseTimeoutMs = 300

    // Act
    const started = Date.now()
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles([CONFIG, USE]),
      contents,
      grammarSource: createNodeGrammarSource(),
      precision: {
        policy: resolvePrecisionPolicy("balanced", { phaseTimeoutMs }),
        libSource: neverSettles,
      },
    })
    const elapsed = Date.now() - started

    // Assert — a complete ast-only analysis, returned within the cap (plus parse time).
    const expectedNoLspEdges = true
    expect(result.edges.every((edge) => edge.source !== "lsp")).toBe(expectedNoLspEdges)
    expect(result.files.length).toBe(2)
    expect(elapsed).toBeLessThan(phaseTimeoutMs + 10_000)
  })

  it("still merges when the phase finishes inside the ceiling", async () => {
    // Arrange — a generous ceiling; the same inputs must now yield lsp edges.
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles([CONFIG, USE]),
      contents,
      grammarSource: createNodeGrammarSource(),
      precision: {
        policy: resolvePrecisionPolicy("balanced", { phaseTimeoutMs: 60_000 }),
        libSource: createNodeLibSource(),
      },
    })

    // Assert
    expect(result.edges.some((edge) => edge.source === "lsp")).toBe(true)
  })
})

describe("mergePreciseEdges — still pure under the new call shape", () => {
  it("adds nothing when the index yielded no references", () => {
    // Arrange
    const astResult: AnalysisResult = {
      engine: "deep",
      pr: prMeta,
      files: [],
      symbols: [configSymbol],
      edges: [],
      ranking: [],
      ghosts: [],
      occurrences: [],
    }

    // Act
    const { result, stats } = mergePreciseEdges(astResult, [])

    // Assert
    expect(result.edges).toEqual([])
    expect(stats).toEqual({ confirmed: 0, added: 0, unchanged: 0 })
  })
})
