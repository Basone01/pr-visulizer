import { describe, expect, it } from "vitest"

import { createNodeGrammarSource } from "../src/node.js"
import { analyzeFastFromSources } from "../src/services/analysis/analyzeFastSources.js"

// Fast-engine (in-process, changed-files-only) support for PHP + Python (docs/architecture.md
// §5). TS relative resolution is `.ts/.js`-shaped and Go is directory-based, so PHP `use` and
// Python dotted/relative imports resolve through their own per-family resolvers here — but, like
// TS aliased specifiers in fast mode, only against the CHANGED file set. Each test proves a file
// edge AND a symbol edge appears between two changed files. Samples are valid PHP 7.4 / Python 3.

const grammarSource = createNodeGrammarSource()

const meta = {
  owner: "acme",
  repo: "fast",
  number: 3,
  title: "fast foreign",
  author: "octocat",
  baseSha: "basefast01",
  headSha: "headfast01",
}

describe("fast engine — Python changed-file edges", () => {
  it("links a relative import + call between two changed files", async () => {
    // Arrange — util.py defines make_config; main.py imports it relatively and calls it.
    const utilPath = "app/util.py"
    const mainPath = "app/main.py"
    const files = [
      {
        path: utilPath,
        status: "added" as const,
        additions: 2,
        deletions: 0,
        language: "python",
        patch: null,
      },
      {
        path: mainPath,
        status: "added" as const,
        additions: 3,
        deletions: 0,
        language: "python",
        patch: null,
      },
    ]
    const contents = [
      "def make_config():\n    return 1\n",
      "from .util import make_config\n\n\ndef run():\n    return make_config()\n",
    ]
    const expectedFileEdge = {
      from: mainPath,
      to: utilPath,
      kind: "imports",
      level: "file",
      source: "ast",
    }
    const expectedSymbolEdge = {
      from: `${mainPath}#run`,
      to: `${utilPath}#make_config`,
      kind: "calls",
      level: "symbol",
      source: "ast",
    }

    // Act
    const result = await analyzeFastFromSources({ pr: meta, files, contents, grammarSource })
    const fileEdge = result.edges.find(
      (edge) => edge.level === "file" && edge.from === mainPath && edge.to === utilPath
    )
    const symbolEdge = result.edges.find(
      (edge) => edge.level === "symbol" && edge.from === `${mainPath}#run`
    )

    // Assert
    expect({ fileEdge, symbolEdge }).toEqual({
      fileEdge: expectedFileEdge,
      symbolEdge: expectedSymbolEdge,
    })
  })
})

describe("fast engine — PHP changed-file edges", () => {
  it("links a use import + static call between two changed files", async () => {
    // Arrange — User.php defines class User::create; Widget.php uses it (typed param + call).
    const userPath = "src/Model/User.php"
    const widgetPath = "src/Service/Widget.php"
    const files = [
      {
        path: userPath,
        status: "added" as const,
        additions: 4,
        deletions: 0,
        language: "php",
        patch: null,
      },
      {
        path: widgetPath,
        status: "added" as const,
        additions: 5,
        deletions: 0,
        language: "php",
        patch: null,
      },
    ]
    const contents = [
      "<?php\nnamespace App\\Model;\n\nclass User {\n    public static function create(): int {\n        return 1;\n    }\n}\n",
      "<?php\nnamespace App\\Service;\n\nuse App\\Model\\User;\n\nfunction build(User $u): int {\n    return User::create();\n}\n",
    ]
    const buildId = `${widgetPath}#build`
    const expectedFileEdge = {
      from: widgetPath,
      to: userPath,
      kind: "imports",
      level: "file",
      source: "ast",
    }
    const expectedCallEdge = {
      from: buildId,
      to: `${userPath}#create`,
      kind: "calls",
      level: "symbol",
      source: "ast",
    }

    // Act
    const result = await analyzeFastFromSources({ pr: meta, files, contents, grammarSource })
    const fileEdge = result.edges.find(
      (edge) => edge.level === "file" && edge.from === widgetPath && edge.to === userPath
    )
    const callEdge = result.edges.find(
      (edge) => edge.from === buildId && edge.to === `${userPath}#create`
    )

    // Assert — the `use App\Model\User` resolved to the changed User.php by namespace suffix.
    expect({ fileEdge, callEdge }).toEqual({
      fileEdge: expectedFileEdge,
      callEdge: expectedCallEdge,
    })
  })
})
