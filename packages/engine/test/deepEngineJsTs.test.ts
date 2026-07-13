import { describe, expect, it } from "vitest"

import type { GatewayChangedFile } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"
import { analyzeDeepFromSources } from "../src/services/analysis/analyzeDeepSources.js"

// JS/TS dependency links (docs/architecture.md §5 step 6/7, §6). Four things the TS path was
// missing before, each pinned by a case below:
//   1. tsconfig `paths` aliases (`@/…`) resolved to nothing
//   2. `.js/.jsx/.mjs/.cjs` were never parsed (no grammar mapping)
//   3. an imported CONST read as a value produced no reference — Go emitted `use`, TS did not
//   4. `export … from` re-exports produced neither a file edge nor a binding
// A namespace import (`import * as ns`) is also resolved, mirroring Go's `pkg.Func` qualifier.

const TSCONFIG = `{
  // absolute imports
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
  }
}`

const config = `export const CONFIG = { mongoUri: "mongodb://x" }
export const RETRIES = 3
`

// Consumes CONFIG as a VALUE (never calls it) — case 3.
const mongo = `import { CONFIG } from "./config"

export function createClient() {
  return connect(CONFIG.mongoUri)
}
`

// Aliased import (case 1) + a namespace import + a constructor.
const service = `import { CONFIG } from "@/config"
import * as mongo from "@/mongo"

export class Service {
  start() {
    const client = mongo.createClient()
    return new Loader(client, CONFIG.mongoUri)
  }
}

export class Loader {}
`

// A barrel that re-exports — case 4.
const barrel = `export { CONFIG } from "./config"
`

// A plain .js file importing a TS symbol — case 2.
const legacyScript = `import { RETRIES } from "./config"

export function retryCount() {
  return RETRIES
}
`

// An exported arrow const has NO statement_block, so its body sits directly under the
// `export_statement`. A reference collector that decides "is this a binding site?" by walking
// ancestors to the statement wrongly discards CONFIG here. Guards that regression.
const arrowConst = `import { CONFIG } from "./config"

export const readUri = () => CONFIG.mongoUri
`

// A .tsx component (tsx grammar) and a .jsx one (javascript grammar) — both must parse JSX
// and link the const they import.
const widget = `import { CONFIG } from "./config"

export function Widget() {
  return <div title={CONFIG.mongoUri} />
}
`

const legacyWidget = `import { RETRIES } from "./config"

export function LegacyWidget() {
  return <span>{RETRIES}</span>
}
`

const PATHS = {
  config: "src/config.ts",
  mongo: "src/mongo.ts",
  service: "src/service.ts",
  barrel: "src/index.ts",
  legacy: "src/legacy.js",
  arrow: "src/arrow.ts",
  widget: "src/Widget.tsx",
  legacyWidget: "src/LegacyWidget.jsx",
} as const

const REPO: Record<string, string> = {
  "tsconfig.json": TSCONFIG,
  [PATHS.config]: config,
  [PATHS.mongo]: mongo,
  [PATHS.service]: service,
  [PATHS.barrel]: barrel,
  [PATHS.legacy]: legacyScript,
  [PATHS.arrow]: arrowConst,
  [PATHS.widget]: widget,
  [PATHS.legacyWidget]: legacyWidget,
}

const PR_META = {
  owner: "acme",
  repo: "web",
  number: 7,
  title: "js/ts links",
  author: "octocat",
  baseSha: "base0007",
  headSha: "head0007",
}

// Every source file is ADDED, so all its symbols count as changed and every resolvable
// reference between them becomes a symbol edge.
function changedFiles(paths: readonly string[]): GatewayChangedFile[] {
  return paths.map((path) => ({
    path,
    status: "added" as const,
    additions: 10,
    deletions: 0,
    language: null,
    patch: null,
  }))
}

function analyze(paths: readonly string[]) {
  const contents = new Map(Object.entries(REPO))

  return analyzeDeepFromSources({
    pr: PR_META,
    files: changedFiles(paths),
    contents,
    grammarSource: createNodeGrammarSource(),
  })
}

const fileEdge = (from: string, to: string) => ({ from, to, level: "file" })
const symbolEdge = (from: string, to: string, kind: string) => ({ from, to, kind, level: "symbol" })

function fileEdges(result: Awaited<ReturnType<typeof analyze>>) {
  return result.edges
    .filter((edge) => edge.level === "file")
    .map((edge) => ({ from: edge.from, to: edge.to, level: edge.level }))
}

function symbolEdges(result: Awaited<ReturnType<typeof analyze>>) {
  return result.edges
    .filter((edge) => edge.level === "symbol")
    .map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, level: edge.level }))
}

describe("deep engine — TS value references (Go parity)", () => {
  it("links a function to the imported CONST it reads, not just the ones it calls", async () => {
    // Arrange — mongo.ts reads CONFIG.mongoUri; it never calls CONFIG.
    const changed = [PATHS.config, PATHS.mongo]

    // Act
    const result = await analyze(changed)

    // Assert — the `use` kind Go always emitted and TS never did.
    const expectedEdge = symbolEdge(`${PATHS.mongo}#createClient`, `${PATHS.config}#CONFIG`, "uses")
    expect(symbolEdges(result)).toContainEqual(expectedEdge)
  })
})

describe("deep engine — tsconfig path aliases", () => {
  it("resolves an @/ import to a file edge and a symbol edge", async () => {
    // Arrange — service.ts imports "@/config", which no relative resolution can reach.
    const changed = [PATHS.config, PATHS.mongo, PATHS.service]

    // Act
    const result = await analyze(changed)

    // Assert
    const expectedFileEdge = fileEdge(PATHS.service, PATHS.config)
    const expectedSymbolEdge = symbolEdge(
      `${PATHS.service}#start`,
      `${PATHS.config}#CONFIG`,
      "uses"
    )
    expect(fileEdges(result)).toContainEqual(expectedFileEdge)
    expect(symbolEdges(result)).toContainEqual(expectedSymbolEdge)
  })

  it("resolves a namespace import's qualified call, like Go's pkg.Func", async () => {
    // Arrange — service.ts does `import * as mongo from "@/mongo"` then `mongo.createClient()`.
    const changed = [PATHS.config, PATHS.mongo, PATHS.service]

    // Act
    const result = await analyze(changed)

    // Assert
    const expectedEdge = symbolEdge(
      `${PATHS.service}#start`,
      `${PATHS.mongo}#createClient`,
      "calls"
    )
    expect(symbolEdges(result)).toContainEqual(expectedEdge)
  })
})

describe("deep engine — re-exports", () => {
  it("treats `export { X } from` as a file dependency on the target", async () => {
    // Arrange
    const changed = [PATHS.config, PATHS.barrel]

    // Act
    const result = await analyze(changed)

    // Assert
    const expectedFileEdge = fileEdge(PATHS.barrel, PATHS.config)
    expect(fileEdges(result)).toContainEqual(expectedFileEdge)
  })
})

describe("deep engine — exported declarations with no statement block", () => {
  it("keeps a value reference inside an exported arrow const", async () => {
    // Arrange — `export const readUri = () => CONFIG.mongoUri` has no statement_block, so its
    // body hangs directly off the export_statement.
    const changed = [PATHS.config, PATHS.arrow]

    // Act
    const result = await analyze(changed)

    // Assert
    const expectedEdge = symbolEdge(`${PATHS.arrow}#readUri`, `${PATHS.config}#CONFIG`, "uses")
    expect(symbolEdges(result)).toContainEqual(expectedEdge)
  })
})

describe("deep engine — JSX", () => {
  it("links a .tsx component to the const it reads inside JSX", async () => {
    // Arrange
    const changed = [PATHS.config, PATHS.widget]

    // Act
    const result = await analyze(changed)

    // Assert
    const expectedEdge = symbolEdge(`${PATHS.widget}#Widget`, `${PATHS.config}#CONFIG`, "uses")
    expect(symbolEdges(result)).toContainEqual(expectedEdge)
  })

  it("links a .jsx component too — the javascript grammar parses JSX", async () => {
    // Arrange
    const changed = [PATHS.config, PATHS.legacyWidget]

    // Act
    const result = await analyze(changed)

    // Assert
    const expectedEdge = symbolEdge(
      `${PATHS.legacyWidget}#LegacyWidget`,
      `${PATHS.config}#RETRIES`,
      "uses"
    )
    expect(fileEdges(result)).toContainEqual(fileEdge(PATHS.legacyWidget, PATHS.config))
    expect(symbolEdges(result)).toContainEqual(expectedEdge)
  })
})

describe("deep engine — plain JavaScript", () => {
  it("parses a .js file and links it to the TS const it imports", async () => {
    // Arrange — legacy.js was invisible to the engine before (.js had no grammar).
    const changed = [PATHS.config, PATHS.legacy]

    // Act
    const result = await analyze(changed)

    // Assert — the .js file contributes its own symbol AND a resolved dependency.
    const expectedFileEdge = fileEdge(PATHS.legacy, PATHS.config)
    const expectedSymbolEdge = symbolEdge(
      `${PATHS.legacy}#retryCount`,
      `${PATHS.config}#RETRIES`,
      "uses"
    )
    const legacySymbols = result.symbols.filter((symbol) => symbol.path === PATHS.legacy)

    expect(legacySymbols.map((symbol) => symbol.name)).toEqual(["retryCount"])
    expect(fileEdges(result)).toContainEqual(expectedFileEdge)
    expect(symbolEdges(result)).toContainEqual(expectedSymbolEdge)
  })
})

describe("deep engine — external packages stay external", () => {
  it("never turns a bare package import into an edge", async () => {
    // Arrange — `connect(...)` in mongo.ts is an unbound global, and nothing imports "mongodb".
    const changed = [PATHS.config, PATHS.mongo]

    // Act
    const result = await analyze(changed)

    // Assert — every edge endpoint is a repo file we changed.
    const changedPaths = new Set<string>(changed)
    const symbolPath = (id: string): string => id.split("#")[0]!
    const offRepoEdges = result.edges.filter((edge) =>
      edge.level === "file"
        ? !changedPaths.has(edge.from) || !changedPaths.has(edge.to)
        : !changedPaths.has(symbolPath(edge.from)) || !changedPaths.has(symbolPath(edge.to))
    )

    expect(offRepoEdges).toEqual([])
  })
})
