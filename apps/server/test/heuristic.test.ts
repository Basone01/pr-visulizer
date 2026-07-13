import type { GatewayFixture } from "@pr-visulizer/engine"
import { analysisResultSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp, pollAnalysisReady } from "./helpers/buildTestApp.js"

// Unknown-language fallback (docs/architecture.md §5): a file with no tree-sitter grammar must
// stay in the graph with edges from the import-line regex only, tagged source:'heuristic' — and
// never crash the pipeline. A Vue SFC standing in for "no grammar shipped"; `.js` no longer
// qualifies, because the engine now parses JS/JSX with the javascript grammar (see the second
// case, which pins that new contract).

const VUE_FIXTURE: GatewayFixture = {
  meta: {
    owner: "acme",
    repo: "legacy",
    number: 7,
    title: "Legacy SFC tweak",
    author: "octocat",
    baseSha: "base0007",
    headSha: "head0007",
  },
  files: [
    {
      path: "src/a.vue",
      status: "added",
      additions: 2,
      deletions: 0,
      language: null,
      patch: "@@ -0,0 +1,2 @@\n",
    },
    {
      path: "src/b.js",
      status: "added",
      additions: 1,
      deletions: 0,
      language: null,
      patch: "@@ -0,0 +1,1 @@\n",
    },
  ],
  contents: {
    "src/a.vue": `<script setup>\nimport { b } from "./b.js"\n</script>\n`,
    "src/b.js": `export const b = () => 1\n`,
  },
}

// The same two-file shape, but both files are plain JavaScript — now a parsed language.
const JS_FIXTURE: GatewayFixture = {
  meta: {
    owner: "acme",
    repo: "scripts",
    number: 8,
    title: "Plain JS tweak",
    author: "octocat",
    baseSha: "base0008",
    headSha: "head0008",
  },
  files: [
    {
      path: "src/a.js",
      status: "added",
      additions: 2,
      deletions: 0,
      language: null,
      patch: "@@ -0,0 +1,2 @@\n",
    },
    {
      path: "src/b.js",
      status: "added",
      additions: 1,
      deletions: 0,
      language: null,
      patch: "@@ -0,0 +1,1 @@\n",
    },
  ],
  contents: {
    "src/a.js": `import { b } from "./b.js"\nexport const a = () => b()\n`,
    "src/b.js": `export const b = () => 1\n`,
  },
}

const VUE_ANALYSIS_URL = "/api/prs/acme/legacy/7/analysis?engine=fast"
const JS_ANALYSIS_URL = "/api/prs/acme/scripts/8/analysis?engine=fast"

describe("GET /analysis with an unknown-language PR", () => {
  it("keeps the file in the graph with a heuristic edge and does not crash", async () => {
    // Arrange
    const { app } = buildTestApp([VUE_FIXTURE])

    // Act
    const result = analysisResultSchema.parse(await pollAnalysisReady(app, VUE_ANALYSIS_URL))
    const vueFile = result.files.find((file) => file.path === "src/a.vue")
    const edge = result.edges.find((e) => e.from === "src/a.vue" && e.to === "src/b.js")

    // Assert
    const expected = { language: null, edgeSource: "heuristic", fileCount: 2 }
    expect({
      language: vueFile?.language,
      edgeSource: edge?.source,
      fileCount: result.files.length,
    }).toEqual(expected)
  })
})

describe("GET /analysis with a plain-JavaScript PR", () => {
  it("parses .js with a real grammar, so its edge is ast — not heuristic", async () => {
    // Arrange
    const { app } = buildTestApp([JS_FIXTURE])

    // Act
    const result = analysisResultSchema.parse(await pollAnalysisReady(app, JS_ANALYSIS_URL))
    const edge = result.edges.find((e) => e.from === "src/a.js" && e.to === "src/b.js")
    const exportedNames = result.symbols.map((symbol) => symbol.name).sort()

    // Assert — a parsed grammar also yields symbols, which the heuristic never could.
    const expected = { edgeSource: "ast", exportedNames: ["a", "b"] }
    expect({ edgeSource: edge?.source, exportedNames }).toEqual(expected)
  })
})
