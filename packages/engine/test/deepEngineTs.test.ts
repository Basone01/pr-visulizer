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

// The TS deep case (docs/architecture.md §6 example): an UNCHANGED file `admin.ts` also
// calls the changed `withRateLimit` middleware. The fast engine never reads unchanged
// files, so it cannot see it; deep mode reads the whole checkout and must surface it as a
// ghost with a blast-radius contribution. Reuses the PR #42 fixture contents plus this
// one extra unchanged file.

const ADMIN_PATH = "src/api/routes/admin.ts"
const WITH_RATE_LIMIT_ID = `${PR42_PATHS.withRateLimit}#withRateLimit`

const adminSource = `import { withRateLimit } from "../../middleware/withRateLimit.js"

export function adminHandler() {
  const guarded = withRateLimit(() => null)
  return guarded()
}
`

const target = { owner: PR42_META.owner, repo: PR42_META.repo, number: PR42_META.number }

function buildTsDeepEngine() {
  const gateway = createFakeGithubGateway() // default PR #42 fixture (6 changed files)
  const repoFiles = createInMemoryRepoFiles({ ...PR42_CONTENTS, [ADMIN_PATH]: adminSource })
  return createDeepEngine({ gateway, repoFiles, grammarSource: createNodeGrammarSource() })
}

describe("createDeepEngine — TS unchanged caller of changed code", () => {
  it("emits the unchanged importer as a ghost using the changed symbol", async () => {
    // Arrange
    const engine = buildTsDeepEngine()
    const expectedGhost = { path: ADMIN_PATH, usedChangedSymbols: [WITH_RATE_LIMIT_ID] }

    // Act
    const result = await engine.analyze(target)
    const adminGhost = result.ghosts.find((ghost) => ghost.path === ADMIN_PATH)

    // Assert
    expect(adminGhost).toEqual(expectedGhost)
  })

  it("gives withRateLimit.ts blastRadius 1 — the lone unchanged caller (login.ts is changed)", async () => {
    // Arrange
    const engine = buildTsDeepEngine()
    const expectedBlastRadius = 1

    // Act
    const result = await engine.analyze(target)
    const withRateLimitRanked = result.ranking.find(
      (ranked) => ranked.path === PR42_PATHS.withRateLimit
    )

    // Assert
    expect(withRateLimitRanked?.blastRadius).toBe(expectedBlastRadius)
  })

  it("records the ghost file's usage as a repo-wide occurrence", async () => {
    // Arrange
    const engine = buildTsDeepEngine()

    // Act
    const result = await engine.analyze(target)
    const adminUsage = result.occurrences.find(
      (occurrence) =>
        occurrence.symbolId === WITH_RATE_LIMIT_ID &&
        occurrence.path === ADMIN_PATH &&
        occurrence.role === "usage"
    )

    // Assert
    const expected = { symbolId: WITH_RATE_LIMIT_ID, path: ADMIN_PATH, line: 4, role: "usage" }
    expect(adminUsage).toEqual(expected)
  })
})
