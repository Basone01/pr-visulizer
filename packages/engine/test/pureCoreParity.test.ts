import { describe, expect, it } from "vitest"

import {
  DEFAULT_FAST_LIMITS,
  DEFAULT_REPO_SCAN,
  PR42_CONTENTS,
  PR42_META,
  PR42_PATHS,
  analyzeDeepFromSources,
  analyzeFastFromSources,
  createDeepEngine,
  createFakeGithubGateway,
  createFastAstEngine,
  createInMemoryRepoFiles,
  readRepoSources,
} from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// The I/O/CPU split (docs/architecture.md §5/§6) is only trustworthy if the extracted PURE
// core produces the EXACT result the node wrapper does — same fixture, wrapper vs core.
// This is the guard that lets the desktop Web Worker run `analyze*FromSources` directly and
// know it matches the BFF byte-for-byte. jsdom cannot run a real Worker, so this parity plus
// the app-side protocol test are what the worker path relies on (the live run proves the
// wasm-in-worker fetch, which no headless test can).

const target = { owner: PR42_META.owner, repo: PR42_META.repo, number: PR42_META.number }
const ADMIN_PATH = "src/api/routes/admin.ts"

const adminSource = `import { withRateLimit } from "../../middleware/withRateLimit.js"

export function adminHandler() {
  const guarded = withRateLimit(() => null)
  return guarded()
}
`

describe("pure analysis cores match their node engine wrappers (PR #42)", () => {
  it("analyzeFastFromSources equals createFastAstEngine.analyze", async () => {
    // Arrange
    const grammarSource = createNodeGrammarSource()
    const wrapperGateway = createFakeGithubGateway()
    const coreGateway = createFakeGithubGateway()
    const engine = createFastAstEngine({ gateway: wrapperGateway, grammarSource })

    // The wrapper's own step 1–3 I/O, reproduced here to feed the pure core the same sources.
    const { pr, files } = await coreGateway.getPullRequest(target)
    const contents = await Promise.all(
      files.map((file) =>
        file.status === "deleted"
          ? Promise.resolve(undefined)
          : coreGateway.getFileContent(target, file.path, pr.headSha)
      )
    )

    // Act
    const viaWrapper = await engine.analyze(target)
    const viaCore = await analyzeFastFromSources({ pr, files, contents, grammarSource })

    // Assert
    expect(viaCore).toEqual(viaWrapper)
  })

  it("analyzeDeepFromSources equals createDeepEngine.analyze", async () => {
    // Arrange
    const grammarSource = createNodeGrammarSource()
    const repoContents = { ...PR42_CONTENTS, [ADMIN_PATH]: adminSource }
    const wrapperGateway = createFakeGithubGateway()
    const coreGateway = createFakeGithubGateway()
    const engine = createDeepEngine({
      gateway: wrapperGateway,
      repoFiles: createInMemoryRepoFiles(repoContents),
      grammarSource,
    })

    // The wrapper's own read of the whole checkout, reproduced to feed the pure core.
    const { pr, files } = await coreGateway.getPullRequest(target)
    const { contents } = await readRepoSources(
      createInMemoryRepoFiles(repoContents),
      DEFAULT_REPO_SCAN
    )

    // Act
    const viaWrapper = await engine.analyze(target)
    const viaCore = await analyzeDeepFromSources({ pr, files, contents, grammarSource })

    // Assert
    expect(viaCore).toEqual(viaWrapper)
  })

  it("keeps the fast fetch-concurrency default a controllable knob (unused by the pure core)", () => {
    // Arrange
    const expectedFetchConcurrency = 6

    // Act
    const actual = DEFAULT_FAST_LIMITS.fetchConcurrency

    // Assert
    expect(actual).toBe(expectedFetchConcurrency)
    // The changed-file paths are stable fixtures the core parity leans on.
    expect(PR42_PATHS.withRateLimit).toBeTruthy()
  })
})
