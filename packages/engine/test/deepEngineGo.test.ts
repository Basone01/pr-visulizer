import { describe, expect, it } from "vitest"

import { createDeepEngine, createFakeGithubGateway, createInMemoryRepoFiles } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"
import {
  GO_BUILD_ID,
  GO_METRICS_META,
  GO_METRICS_PATHS,
  GO_METRICS_REPO,
  GO_REPORT_ID,
  goMetricsFixture,
} from "./fixtures/goMetrics.js"

// The motivating deep-engine case (docs/architecture.md §6): a Go PR that only ADDS a
// field to struct `Report` — zero call edges. Two changed files reference `Report`
// same-package (no import, no qualifier), and two UNCHANGED files reference it too. Fast
// mode reads only the changed files' own imports, so it sees NONE of these links. Deep
// mode indexes the whole repo and must surface every one.

const target = {
  owner: GO_METRICS_META.owner,
  repo: GO_METRICS_META.repo,
  number: GO_METRICS_META.number,
}

function buildGoDeepEngine() {
  const gateway = createFakeGithubGateway([goMetricsFixture()])
  const repoFiles = createInMemoryRepoFiles(GO_METRICS_REPO)
  return createDeepEngine({ gateway, repoFiles, grammarSource: createNodeGrammarSource() })
}

describe("createDeepEngine — Go same-package struct-field PR", () => {
  it("links the two CHANGED files with a uses-type edge and emits no call edges", async () => {
    // Arrange
    const engine = buildGoDeepEngine()
    const expectedEdge = {
      from: GO_BUILD_ID, // pkg/metrics/report_builder.go#Build
      to: GO_REPORT_ID, // pkg/metrics/types.go#Report
      kind: "uses-type",
      level: "symbol",
      source: "ast",
    }

    // Act
    const result = await engine.analyze(target)
    const buildToReport = result.edges.find(
      (edge) => edge.from === GO_BUILD_ID && edge.to === GO_REPORT_ID
    )
    const callEdgeCount = result.edges.filter((edge) => edge.kind === "calls").length

    // Assert
    expect({ edge: buildToReport, callEdgeCount }).toEqual({ edge: expectedEdge, callEdgeCount: 0 })
  })

  it("emits both UNCHANGED referrers as ghosts using the changed Report symbol", async () => {
    // Arrange
    const engine = buildGoDeepEngine()
    const expectedGhosts = {
      [GO_METRICS_PATHS.aggregate]: [GO_REPORT_ID], // same-package, unqualified
      [GO_METRICS_PATHS.handler]: [GO_REPORT_ID], // cross-package, metrics.Report
    }

    // Act
    const result = await engine.analyze(target)
    const ghostMap = Object.fromEntries(
      result.ghosts.map((ghost) => [ghost.path, ghost.usedChangedSymbols])
    )

    // Assert
    expect(ghostMap).toEqual(expectedGhosts)
  })

  it("reports blastRadius 2 for the changed struct file (its two unchanged dependents)", async () => {
    // Arrange
    const engine = buildGoDeepEngine()
    const expectedBlastRadius = 2

    // Act
    const result = await engine.analyze(target)
    const typesRanked = result.ranking.find((ranked) => ranked.path === GO_METRICS_PATHS.types)

    // Assert
    expect(typesRanked?.blastRadius).toBe(expectedBlastRadius)
  })

  it("records repo-wide Report usage occurrences, including the ghost files", async () => {
    // Arrange
    const engine = buildGoDeepEngine()
    const usageLinesFor = (
      occurrences: Array<{ path: string; line: number }>,
      path: string
    ): number[] =>
      occurrences
        .filter((occurrence) => occurrence.path === path)
        .map((occurrence) => occurrence.line)
        .sort((a, b) => a - b)

    // Act
    const result = await engine.analyze(target)
    const reportUsages = result.occurrences.filter(
      (occurrence) => occurrence.symbolId === GO_REPORT_ID && occurrence.role === "usage"
    )

    // Assert
    const expected = { aggregate: [3], handler: [5, 6] }
    expect({
      aggregate: usageLinesFor(reportUsages, GO_METRICS_PATHS.aggregate),
      handler: usageLinesFor(reportUsages, GO_METRICS_PATHS.handler),
    }).toEqual(expected)
  })
})

// Regression (the cobra case): two changed files at the REPO ROOT, same package, where the
// test file references only an UNCHANGED symbol of its sibling. No import statement exists
// (same package) and no changed symbol is referenced — yet the files must still link at the
// file level so the ranking reviews the definition before its test.
describe("createDeepEngine — root-level same-package changed files, unrelated changed lines", () => {
  it("links test → subject via an any-symbol reference and ranks the subject first", async () => {
    // Arrange — command.go defines UNCHANGED struct App; its changed line is elsewhere.
    // command_test.go (changed) references App only.
    const commandSource = [
      "package cli",
      "",
      "type App struct {", // UNCHANGED symbol — the PR touches Run below
      "\tName string",
      "}",
      "",
      "func Run() error {",
      "\treturn nil",
      "}",
      "",
    ].join("\n")
    const commandTestSource = [
      "package cli",
      "",
      'import "testing"',
      "",
      "func TestApp(t *testing.T) {",
      '\tapp := App{Name: "x"}',
      "\t_ = app",
      "}",
      "",
    ].join("\n")
    const goModSource = "module example.com/cli\n"
    const headSha = "roothead0001"
    const meta = {
      owner: "acme",
      repo: "cli",
      number: 7,
      title: "tweak Run",
      author: "someone",
      baseSha: "rootbase0001",
      headSha,
    }
    // Hunks: command.go changed at Run's body (line 8); command_test.go fully added.
    const files = [
      {
        path: "command.go",
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        language: "go",
        patch: "@@ -8,1 +8,1 @@\n-\treturn nil\n+\treturn nil // tweaked\n",
      },
      {
        path: "command_test.go",
        status: "added" as const,
        additions: 8,
        deletions: 0,
        language: "go",
        patch: "@@ -0,0 +1,8 @@\n",
      },
    ]
    const gateway = createFakeGithubGateway([
      {
        meta,
        files,
        contents: { "command.go": commandSource, "command_test.go": commandTestSource },
      },
    ])
    const repoFiles = createInMemoryRepoFiles({
      "go.mod": goModSource,
      "command.go": commandSource,
      "command_test.go": commandTestSource,
    })
    const engine = createDeepEngine({
      gateway,
      repoFiles,
      grammarSource: createNodeGrammarSource(),
    })
    const rootTarget = { owner: meta.owner, repo: meta.repo, number: meta.number }

    // Act
    const result = await engine.analyze(rootTarget)

    // Assert — file-level dependency from the any-symbol reference, definition ranked first.
    const expectedFileEdge = {
      from: "command_test.go",
      to: "command.go",
      level: "file",
      source: "ast",
    }
    expect(result.edges).toEqual(
      expect.arrayContaining([expect.objectContaining(expectedFileEdge)])
    )
    expect(result.ranking.map((entry) => entry.path)).toEqual(["command.go", "command_test.go"])
  })
})
