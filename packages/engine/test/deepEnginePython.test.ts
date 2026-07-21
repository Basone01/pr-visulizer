import { describe, expect, it } from "vitest"

import { createDeepEngine, createFakeGithubGateway, createInMemoryRepoFiles } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// Deep-engine repo-wide resolution for Python (docs/architecture.md §6): a small package where
// a CHANGED file resolves its dependency through a RELATIVE import, an UNCHANGED file references
// the changed symbol through a QUALIFIED (`cfg.make_config`) call, and the changed function is
// linked to its definition. Fast mode reads only a changed file's own imports, so the unchanged
// referrer is invisible to it; deep mode indexes the whole checkout and surfaces it as a ghost.

const CONFIG_PATH = "app/config.py"
const SERVICE_PATH = "app/service.py"
const WORKER_PATH = "app/worker.py"

const CONFIG_ID = `${CONFIG_PATH}#make_config`
const BUILD_ID = `${SERVICE_PATH}#build`

// config.py defines make_config (CHANGED). service.py (CHANGED) imports it RELATIVELY and calls
// it. worker.py (UNCHANGED) reaches it through a QUALIFIED `cfg.make_config()` call.
const configSource = `def make_config():
    return 1
`
const serviceSource = `from .config import make_config


def build():
    return make_config()
`
const workerSource = `import app.config as cfg


def work():
    return cfg.make_config()
`

const meta = {
  owner: "acme",
  repo: "pyservice",
  number: 11,
  title: "tweak make_config",
  author: "contributor-dev",
  baseSha: "basepy0001",
  headSha: "headpy0001",
}

const target = { owner: meta.owner, repo: meta.repo, number: meta.number }

// Only config.py + service.py changed; worker.py is unchanged repo context.
const changedFiles = [
  {
    path: CONFIG_PATH,
    status: "modified" as const,
    additions: 1,
    deletions: 0,
    language: "python",
    patch: "@@ -1,2 +1,2 @@\n",
  },
  {
    path: SERVICE_PATH,
    status: "added" as const,
    additions: 5,
    deletions: 0,
    language: "python",
    patch: "@@ -0,0 +1,5 @@\n",
  },
]

function buildPythonDeepEngine() {
  const gateway = createFakeGithubGateway([
    {
      meta,
      files: changedFiles,
      contents: { [CONFIG_PATH]: configSource, [SERVICE_PATH]: serviceSource },
    },
  ])
  const repoFiles = createInMemoryRepoFiles({
    [CONFIG_PATH]: configSource,
    [SERVICE_PATH]: serviceSource,
    [WORKER_PATH]: workerSource,
  })

  return createDeepEngine({ gateway, repoFiles, grammarSource: createNodeGrammarSource() })
}

describe("createDeepEngine — Python relative import + qualified reference", () => {
  it("links the two changed files with a file edge and a call symbol edge", async () => {
    // Arrange
    const engine = buildPythonDeepEngine()
    const expectedFileEdge = {
      from: SERVICE_PATH,
      to: CONFIG_PATH,
      kind: "imports",
      level: "file",
      source: "ast",
    }
    const expectedSymbolEdge = {
      from: BUILD_ID,
      to: CONFIG_ID,
      kind: "calls",
      level: "symbol",
      source: "ast",
    }

    // Act
    const result = await engine.analyze(target)
    const fileEdge = result.edges.find(
      (edge) => edge.level === "file" && edge.from === SERVICE_PATH && edge.to === CONFIG_PATH
    )
    const symbolEdge = result.edges.find(
      (edge) => edge.level === "symbol" && edge.from === BUILD_ID && edge.to === CONFIG_ID
    )

    // Assert — the relative `from .config import make_config` resolved to the sibling file.
    expect({ fileEdge, symbolEdge }).toEqual({
      fileEdge: expectedFileEdge,
      symbolEdge: expectedSymbolEdge,
    })
  })

  it("emits the unchanged qualified caller as a ghost and reports blastRadius 1", async () => {
    // Arrange
    const engine = buildPythonDeepEngine()
    const expectedGhosts = { [WORKER_PATH]: [CONFIG_ID] }
    const expectedBlastRadius = 1

    // Act
    const result = await engine.analyze(target)
    const ghostMap = Object.fromEntries(
      result.ghosts.map((ghost) => [ghost.path, ghost.usedChangedSymbols])
    )
    const configRanked = result.ranking.find((ranked) => ranked.path === CONFIG_PATH)

    // Assert — worker.py's `cfg.make_config()` resolved to the changed symbol though worker.py
    // never changed, so it is context (a ghost), and config.py carries a blast radius of 1.
    expect({ ghostMap, blastRadius: configRanked?.blastRadius }).toEqual({
      ghostMap: expectedGhosts,
      blastRadius: expectedBlastRadius,
    })
  })
})
