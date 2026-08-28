import { describe, expect, it } from "vitest"

import {
  PR42_CONTENTS,
  PR42_META,
  PR42_PATHS,
  createDeepEngine,
  createFakeGithubGateway,
  createInMemoryRepoFiles,
} from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// `GhostFile.usesChangedFiles` — which CHANGED files each ghost reaches (docs/architecture.md
// §6, §380). It is the graph's dashed ghost→file edge, so both ways a ghost can reach changed
// code have to land in it: a symbol reference, and a bare import that references nothing.

const SYMBOL_GHOST_PATH = "src/api/routes/admin.ts"
const IMPORT_ONLY_GHOST_PATH = "src/api/routes/health.ts"
const TWO_FILE_GHOST_PATH = "src/api/routes/report.ts"

// Calls the changed `withRateLimit` — a reference, so it also carries usedChangedSymbols.
const symbolGhostSource = `import { withRateLimit } from "../../middleware/withRateLimit.js"

export function adminHandler() {
  const guarded = withRateLimit(() => null)
  return guarded()
}
`

// Imports a changed file for its side effect only — no binding, so no changed SYMBOL is
// referenced. Without the import loop feeding it, this ghost would name no file at all.
const importOnlyGhostSource = `import "../../config/limits.js"

export function healthHandler() {
  return { ok: true }
}
`

// Reaches TWO changed files, so the ghost draws two dashed edges.
const twoFileGhostSource = `import { withRateLimit } from "../../middleware/withRateLimit.js"
import { checkLimit } from "../../lib/rateLimiter.js"

export function reportHandler() {
  const guarded = withRateLimit(() => null)
  return checkLimit({ windowMs: 1, max: 1 }, 1) ? guarded() : null
}
`

const target = { owner: PR42_META.owner, repo: PR42_META.repo, number: PR42_META.number }

function buildGhostDeepEngine() {
  const gateway = createFakeGithubGateway() // default PR #42 fixture (6 changed files)
  const repoFiles = createInMemoryRepoFiles({
    ...PR42_CONTENTS,
    [SYMBOL_GHOST_PATH]: symbolGhostSource,
    [IMPORT_ONLY_GHOST_PATH]: importOnlyGhostSource,
    [TWO_FILE_GHOST_PATH]: twoFileGhostSource,
  })

  return createDeepEngine({ gateway, repoFiles, grammarSource: createNodeGrammarSource() })
}

describe("createDeepEngine — the changed files each ghost reaches", () => {
  it("names the changed file a ghost REFERENCES a symbol from", async () => {
    // Arrange
    const engine = buildGhostDeepEngine()
    const expectedUsesChangedFiles = [PR42_PATHS.withRateLimit]

    // Act
    const result = await engine.analyze(target)
    const symbolGhost = result.ghosts.find((ghost) => ghost.path === SYMBOL_GHOST_PATH)

    // Assert
    expect(symbolGhost?.usesChangedFiles).toEqual(expectedUsesChangedFiles)
  })

  it("names the changed file an IMPORT-ONLY ghost pulls in, with no symbols to show for it", async () => {
    // Arrange
    const engine = buildGhostDeepEngine()
    const expectedUsesChangedFiles = [PR42_PATHS.limits]
    const expectedUsedChangedSymbols: string[] = []

    // Act
    const result = await engine.analyze(target)
    const importOnlyGhost = result.ghosts.find((ghost) => ghost.path === IMPORT_ONLY_GHOST_PATH)

    // Assert
    expect(importOnlyGhost?.usesChangedFiles).toEqual(expectedUsesChangedFiles)
    expect(importOnlyGhost?.usedChangedSymbols).toEqual(expectedUsedChangedSymbols)
  })

  it("names every changed file a ghost reaches, sorted", async () => {
    // Arrange
    const engine = buildGhostDeepEngine()
    const expectedUsesChangedFiles = [PR42_PATHS.rateLimiter, PR42_PATHS.withRateLimit].sort()

    // Act
    const result = await engine.analyze(target)
    const twoFileGhost = result.ghosts.find((ghost) => ghost.path === TWO_FILE_GHOST_PATH)

    // Assert
    expect(twoFileGhost?.usesChangedFiles).toEqual(expectedUsesChangedFiles)
  })
})
