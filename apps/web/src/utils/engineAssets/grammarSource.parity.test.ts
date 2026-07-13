// @vitest-environment node
//
// This file runs under the `node` environment, not the web project's default jsdom, on
// purpose: web-tree-sitter's wasm runtime CANNOT be exercised under jsdom. jsdom replaces
// the global `Uint8Array`, so web-tree-sitter (a Node-loaded module) fails its
// `input instanceof Uint8Array` byte-vs-path check in `Language.load`, misreads the
// grammar bytes as a filesystem path, and throws. The browser LOADER logic under test —
// fetching the bundled `?url` assets and handing the bytes to the engine's GrammarSource
// seam — is realm-independent, so running the ambient JS in node changes nothing about
// what the loader does; it only lets the wasm runtime's own type checks pass. The parse
// below is therefore REAL and identical to the node loader, not a stubbed green claim.
import {
  CORE_GRAMMAR_ID,
  PR42_CONTENTS,
  PR42_PATHS,
  SUPPORTED_GRAMMAR_IDS,
  createSyntaxAnalyzer,
} from "@pr-visulizer/engine"
import { analyzeDeepFromSources } from "@pr-visulizer/engine/browser"
import { createNodeGrammarSource } from "@pr-visulizer/engine/node"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BUNDLED_WASM_URLS, createBrowserGrammarSource } from "./grammarSource"

// Parity test (docs/tauri-architecture.md §8 slice 2): the WEBVIEW grammar loader must
// produce the EXACT same parse as the node loader — same §7 symbols/imports/references —
// so moving the engine into the page changes nothing about the analysis. The browser
// loader fetches bundled `?url` assets; here fetch is mocked to read those same wasm
// files off disk from node_modules, and the parse is real (not a stubbed green claim).

const requireFromHere = createRequire(import.meta.url)

// Every lookup below is a known-present fixture key; make the missing case loud rather
// than let `noUncheckedIndexedAccess`'s `undefined` slip into the loader as a bad url.
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`)

  return value
}

const coreWasmUrl = required(BUNDLED_WASM_URLS[CORE_GRAMMAR_ID], "core wasm url")
const typescriptWasmUrl = required(BUNDLED_WASM_URLS.typescript, "typescript wasm url")
const tsxWasmUrl = required(BUNDLED_WASM_URLS.tsx, "tsx wasm url")
const withRateLimitSource = required(
  PR42_CONTENTS[PR42_PATHS.withRateLimit],
  "withRateLimit fixture"
)

// Reverse-map each bundled asset URL back to the on-disk wasm the browser would fetch. Built
// from BUNDLED_WASM_URLS itself so a newly bundled grammar is served here automatically.
const diskPathByUrl = new Map<string, string>(
  Object.entries(BUNDLED_WASM_URLS).map(([grammarId, url]) => [
    url,
    grammarId === CORE_GRAMMAR_ID
      ? requireFromHere.resolve("web-tree-sitter/tree-sitter.wasm")
      : requireFromHere.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarId}.wasm`),
  ])
)

async function readBundledWasm(input: string): Promise<Response> {
  const diskPath = diskPathByUrl.get(input)
  if (!diskPath) throw new Error(`unexpected fetch url in test: ${input}`)

  return new Response(await readFile(diskPath))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser GrammarSource parity with the node loader (PR #42 withRateLimit.ts)", () => {
  it("produces the same symbols, imports and references as the node loader", async () => {
    // Arrange
    const grammarId = "typescript"
    const source = withRateLimitSource
    vi.stubGlobal("fetch", (input: string) => readBundledWasm(String(input)))
    const nodeAnalyzer = createSyntaxAnalyzer(createNodeGrammarSource())
    const browserAnalyzer = createSyntaxAnalyzer(createBrowserGrammarSource())

    // Act
    const nodeSyntax = await nodeAnalyzer.analyzeSyntax(grammarId, source)
    const browserSyntax = await browserAnalyzer.analyzeSyntax(grammarId, source)

    // Assert
    // The §7 shape, asserted concretely so the reviewer sees what the parse yields.
    const expectedSymbolNames = ["withRateLimit"]
    const expectedCallNames = ["createRateLimiter", "checkLimit"]
    const expectedTypeName = "ApiError"

    expect(browserSyntax).toEqual(nodeSyntax)
    expect(browserSyntax.symbols.map((symbol) => symbol.name)).toEqual(expectedSymbolNames)
    expect(
      browserSyntax.references.filter((ref) => ref.kind === "call").map((ref) => ref.name)
    ).toEqual(expect.arrayContaining(expectedCallNames))
    expect(
      browserSyntax.references.some((ref) => ref.kind === "type" && ref.name === expectedTypeName)
    ).toBe(true)
  })

  it("fetches the bundled core + grammar wasm URLs (loader wiring)", async () => {
    // Arrange
    // Drive the source directly (not through the analyzer) so the assertion is not
    // coupled to Parser.init's once-per-process core cache.
    const fetchedUrls: string[] = []
    vi.stubGlobal("fetch", (input: string) => {
      fetchedUrls.push(String(input))
      return readBundledWasm(String(input))
    })
    const grammarSource = createBrowserGrammarSource()

    // Act
    const coreBytes = await grammarSource(CORE_GRAMMAR_ID)
    const grammarBytes = await grammarSource("typescript")

    // Assert
    const expectedCoreUrl = coreWasmUrl
    const expectedGrammarUrl = typescriptWasmUrl
    expect(fetchedUrls).toEqual([expectedCoreUrl, expectedGrammarUrl])
    expect(coreBytes.byteLength).toBeGreaterThan(0)
    expect(grammarBytes.byteLength).toBeGreaterThan(0)
  })
})

// The bug this pins: `javascript` was shipped in the language map but never bundled here. Node
// tests stayed green (the node loader resolves any grammar off disk), while the APP threw
// `No bundled wasm asset for grammar "javascript"` on the first .js file — and the deep pipeline
// has no per-file catch, so one such file failed the entire analysis.
describe("bundled grammar coverage", () => {
  it("bundles a wasm for every grammar id languageForPath can return", () => {
    // Arrange
    const bundledIds = Object.keys(BUNDLED_WASM_URLS)

    // Act
    const missing = SUPPORTED_GRAMMAR_IDS.filter((grammarId) => !bundledIds.includes(grammarId))

    // Assert
    expect(missing).toEqual([])
  })
})

// The webview's real loader driving the real deep pipeline over one file per supported language.
// This is the check that would have caught the shipped bug: it exercises the BROWSER
// GrammarSource, not the node one.
describe("browser GrammarSource — deep analysis across ts/tsx/js/jsx", () => {
  const PATHS = {
    config: "src/config.ts",
    widget: "src/Widget.tsx",
    legacy: "src/legacy.js",
    legacyWidget: "src/LegacyWidget.jsx",
  } as const

  const REPO: Record<string, string> = {
    [PATHS.config]: `export const CONFIG = { title: "x" }\n`,
    [PATHS.widget]: `import { CONFIG } from "./config"\nexport function Widget() {\n  return <div title={CONFIG.title} />\n}\n`,
    [PATHS.legacy]: `import { CONFIG } from "./config"\nexport const readTitle = () => CONFIG.title\n`,
    [PATHS.legacyWidget]: `import { CONFIG } from "./config"\nexport function LegacyWidget() {\n  return <span>{CONFIG.title}</span>\n}\n`,
  }

  it("produces a file edge and a symbol edge from every language, through the fetched wasm", async () => {
    // Arrange
    vi.stubGlobal("fetch", (input: string) => readBundledWasm(String(input)))
    const contents = new Map(Object.entries(REPO))
    const changedFiles = Object.keys(REPO).map((path) => ({
      path,
      status: "added" as const,
      additions: 4,
      deletions: 0,
      language: null,
      patch: null,
    }))
    const prMeta = {
      owner: "acme",
      repo: "web",
      number: 9,
      title: "js/ts/tsx/jsx",
      author: "octocat",
      baseSha: "base0009",
      headSha: "head0009",
    }

    // Act
    const result = await analyzeDeepFromSources({
      pr: prMeta,
      files: changedFiles,
      contents,
      grammarSource: createBrowserGrammarSource(),
    })

    // Assert — each language contributes both layers, all pointing at the shared const.
    const configSymbolId = `${PATHS.config}#CONFIG`
    const importersOf = (level: string) =>
      result.edges
        .filter((edge) => edge.level === level && edge.to.startsWith(PATHS.config))
        .map((edge) => edge.from.split("#")[0])
        .sort()

    const expectedImporters = [PATHS.legacyWidget, PATHS.legacy, PATHS.widget].sort()
    const expectedSymbolEdgeCount = 3

    expect(importersOf("file")).toEqual(expectedImporters)
    expect(importersOf("symbol")).toEqual(expectedImporters)
    expect(
      result.edges.filter((edge) => edge.level === "symbol" && edge.to === configSymbolId)
    ).toHaveLength(expectedSymbolEdgeCount)
  })
})
