import { analysisResultSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import type { GatewayFixture } from "../src/services/githubGateway/index.js"
import { buildTestApp, pollAnalysisReady } from "./helpers/buildTestApp.js"

// Unknown-language fallback (docs/architecture.md §5): a file with no tree-sitter
// grammar (plain .js in this TS-first MVP) must stay in the graph with edges from the
// import-line regex only, tagged source:'heuristic' — and never crash the pipeline.

const JS_FIXTURE: GatewayFixture = {
  meta: {
    owner: "acme",
    repo: "legacy",
    number: 7,
    title: "Legacy JS tweak",
    baseSha: "base0007",
    headSha: "head0007",
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

const ANALYSIS_URL = "/api/prs/acme/legacy/7/analysis?engine=fast"

describe("GET /analysis with an unknown-language PR", () => {
  it("keeps the file in the graph with a heuristic edge and does not crash", async () => {
    // Arrange
    const { app } = buildTestApp([JS_FIXTURE])

    // Act
    const result = analysisResultSchema.parse(await pollAnalysisReady(app, ANALYSIS_URL))
    const aFile = result.files.find((file) => file.path === "src/a.js")
    const edge = result.edges.find((e) => e.from === "src/a.js" && e.to === "src/b.js")

    // Assert
    const expected = { language: null, edgeSource: "heuristic", fileCount: 2 }
    expect({
      language: aFile?.language,
      edgeSource: edge?.source,
      fileCount: result.files.length,
    }).toEqual(expected)
  })
})
