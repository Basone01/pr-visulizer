import { describe, expect, it } from "vitest"

import { createNodeGrammarSource } from "../src/node.js"
import { analyzeDeepFromSources } from "../src/services/analysis/analyzeDeepSources.js"
import { CORE_GRAMMAR_ID, type GrammarSource } from "../src/services/analysis/treeSitter.js"

// The repo-wide index is parsed only in the resolution FAMILIES the PR touches. Name resolution
// never crosses the Go/TS boundary, so a Go-only PR gains nothing from parsing the repo's
// TypeScript — and pays ~3.9 MB of never-reclaimed wasm heap per TS file for the privilege
// (measured: 969 TS files ≈ 3.8 GB, vs 25 KB/file for Go). That allocation wedged the webview.
//
// The assertion is indirect but exact: a grammar's wasm is fetched the first time a file needs
// it, so "the `typescript` grammar was never requested" means "no TypeScript file was parsed".

const GO_MAIN = "cmd/main.go"
const GO_HELPER = "cmd/helper.go"
const TS_CONFIG = "src/config.ts"
const TSX_WIDGET = "src/Widget.tsx"

const REPO: Record<string, string> = {
  [GO_MAIN]: `package main\n\nfunc Main() {\n\tHelp()\n}\n`,
  [GO_HELPER]: `package main\n\nfunc Help() {}\n`,
  [TS_CONFIG]: `export const CONFIG = { a: 1 }\n`,
  [TSX_WIDGET]: `import { CONFIG } from "./config"\nexport function Widget() {\n  return <div>{CONFIG.a}</div>\n}\n`,
}

const contents = new Map(Object.entries(REPO))

const prMeta = {
  owner: "wisesight",
  repo: "analytics-suite",
  number: 1087,
  title: "family scope",
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

// Records which grammars the analyzer actually asked the platform for.
function countingGrammarSource(): { source: GrammarSource; requested: () => string[] } {
  const real = createNodeGrammarSource()
  const requested: string[] = []

  const source: GrammarSource = async (grammarId) => {
    if (grammarId !== CORE_GRAMMAR_ID) requested.push(grammarId)
    return real(grammarId)
  }

  return { source, requested: () => [...new Set(requested)].sort() }
}

async function analyzeWithCounting(changed: readonly string[]) {
  const { source, requested } = countingGrammarSource()
  const result = await analyzeDeepFromSources({
    pr: prMeta,
    files: changedFiles(changed),
    contents,
    grammarSource: source,
  })

  return { result, grammars: requested() }
}

describe("deep engine — the repo parse is scoped to the PR's grammar families", () => {
  it("never loads a TypeScript grammar for a Go-only PR", async () => {
    // Arrange — the repo contains TS and TSX; only Go files changed.
    const goOnly = [GO_MAIN, GO_HELPER]

    // Act
    const { result, grammars } = await analyzeWithCounting(goOnly)

    // Assert — `typescript`/`tsx` were never even fetched, so no TS file was parsed.
    const expectedGrammars = ["go"]
    expect(grammars).toEqual(expectedGrammars)
    // And the Go analysis is unaffected: main.go calls Help() in the sibling file.
    const expectedEdge = `${GO_MAIN}#Main -> ${GO_HELPER}#Help`
    const symbolEdges = result.edges
      .filter((edge) => edge.level === "symbol")
      .map((edge) => `${edge.from} -> ${edge.to}`)
    expect(symbolEdges).toContain(expectedEdge)
  })

  it("never loads the Go grammar for a TS-only PR", async () => {
    // Arrange
    const tsOnly = [TS_CONFIG, TSX_WIDGET]

    // Act
    const { result, grammars } = await analyzeWithCounting(tsOnly)

    // Assert
    const expectedGrammars = ["tsx", "typescript"].sort()
    expect(grammars).toEqual(expectedGrammars)
    const expectedEdge = `${TSX_WIDGET}#Widget -> ${TS_CONFIG}#CONFIG`
    const symbolEdges = result.edges
      .filter((edge) => edge.level === "symbol")
      .map((edge) => `${edge.from} -> ${edge.to}`)
    expect(symbolEdges).toContain(expectedEdge)
  })

  it("loads both families for a genuinely mixed PR", async () => {
    // Arrange — the analytics-suite shape: a Go service and a TS script in one PR.
    const mixed = [GO_MAIN, TS_CONFIG]

    // Act
    const { grammars } = await analyzeWithCounting(mixed)

    // Assert — a mixed PR must still index both sides; correctness beats the memory saving.
    const expectedGrammars = ["go", "tsx", "typescript"].sort()
    expect(grammars).toEqual(expectedGrammars)
  })

  it("parses nothing when no parseable file changed", async () => {
    // Arrange — docs/config only (the `.bru` files in the real PR).
    const noSource = ["docs/api/GetMessage.bru"]
    const withDoc = new Map(contents)
    withDoc.set("docs/api/GetMessage.bru", "get {}\n")
    const { source, requested } = countingGrammarSource()

    // Act
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles(noSource),
      contents: withDoc,
      grammarSource: source,
    })

    // Assert — no grammar loaded at all, and the analysis still returns a valid result.
    expect(requested()).toEqual([])
    expect(result.symbols).toEqual([])
    expect(result.edges).toEqual([])
  })
})

// Cut 2 — REACHABILITY. Within the TS family, only files that can CONTRIBUTE are parsed: the
// changed files, plus their direct importers (which is what ghosts and blast radius are made
// of). Everything else is dropped, because every consumer discards a reference whose target is
// not a changed symbol. Measured on the real repo: #1222's TS slice needs 3 of 969 parses.
describe("deep engine — the TS parse is restricted to reachable files", () => {
  const CHANGED = "src/config.ts"
  const IMPORTER = "src/importer.ts"
  const ALIAS_IMPORTER = "src/aliased.ts"
  const UNRELATED = "src/unrelated.ts"

  const REACH_REPO: Record<string, string> = {
    "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }`,
    [CHANGED]: `export const CONFIG = { a: 1 }\n`,
    [IMPORTER]: `import { CONFIG } from "./config"\nexport function read() {\n  return CONFIG.a\n}\n`,
    // Reaches the changed file through a tsconfig alias — the regex pre-pass must resolve it.
    [ALIAS_IMPORTER]: `import { CONFIG } from "@/config"\nexport function alt() {\n  return CONFIG.a\n}\n`,
    // Imports nothing from the changed set: it can never reference a changed symbol.
    [UNRELATED]: `export const other = 2\n`,
  }

  const reachContents = new Map(Object.entries(REACH_REPO))

  it("parses the changed file and its importers, and still finds the ghosts", async () => {
    // Arrange — only config.ts changed; two files import it, one does not.
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles([CHANGED]),
      contents: reachContents,
      grammarSource: createNodeGrammarSource(),
    })

    // Assert — both importers are ghosts (they reference the changed CONFIG); the unrelated
    // file appears nowhere. An alias importer must be found exactly like a relative one.
    const ghostPaths = result.ghosts.map((ghost) => ghost.path).sort()
    const expectedGhosts = [ALIAS_IMPORTER, IMPORTER].sort()
    expect(ghostPaths).toEqual(expectedGhosts)
    expect(ghostPaths).not.toContain(UNRELATED)
  })

  it("reports blast radius from the importers it parsed", async () => {
    // Arrange / Act
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles([CHANGED]),
      contents: reachContents,
      grammarSource: createNodeGrammarSource(),
    })

    // Assert — two unchanged dependents.
    const expectedBlastRadius = 2
    const ranked = result.ranking.find((file) => file.path === CHANGED)
    expect(ranked?.blastRadius).toBe(expectedBlastRadius)
  })
})
