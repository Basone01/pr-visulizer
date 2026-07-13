import { describe, expect, it } from "vitest"

import {
  type AnalysisProgress,
  PR42_CONTENTS,
  PR42_META,
  createDeepEngine,
  createFakeGithubGateway,
  createInMemoryRepoFiles,
} from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// The deep engine scans a whole repo — potentially thousands of files — so its reading/parsing
// progress is THROTTLED to ~one event per 25 files (docs/architecture.md §6): the UI must not
// be flooded. This drives a 66-source-file in-memory repo (the 6 PR #42 files + 60 generated)
// and asserts the event stream stays small while still landing the exact final count.
//
// The 60 generated files each IMPORT a changed file. That is deliberate: the deep pass only
// parses files that can contribute — the changed set plus its direct importers — so a generated
// file importing nothing would never be parsed, and this would silently stop testing throttling.
// Keeping them importers means the parse total stays 66 AND the importer rule is exercised.

const target = { owner: PR42_META.owner, repo: PR42_META.repo, number: PR42_META.number }
const EXTRA_FILE_COUNT = 60
const TOTAL_SOURCE_FILES = 6 + EXTRA_FILE_COUNT

function repoWithManyFiles(): ReturnType<typeof createInMemoryRepoFiles> {
  const extra: Record<string, string> = {}
  for (let index = 0; index < EXTRA_FILE_COUNT; index += 1) {
    extra[`src/gen/module${index}.ts`] =
      `import { MAX_REQUESTS } from "../config/limits.js"\nexport const value${index} = ${index} + MAX_REQUESTS\n`
  }

  return createInMemoryRepoFiles({ ...PR42_CONTENTS, ...extra })
}

describe("createDeepEngine — throttled repo-wide progress", () => {
  it("emits far fewer reading/parsing events than files, each on a 25-boundary or the total", async () => {
    // Arrange
    const engine = createDeepEngine({
      gateway: createFakeGithubGateway(),
      repoFiles: repoWithManyFiles(),
      grammarSource: createNodeGrammarSource(),
    })
    const events: AnalysisProgress[] = []
    // 66 files → throttle fires at 25, 50, and the final 66 → 3 events per phase.
    const maxThrottledEvents = 4

    // Act
    await engine.analyze(target, { onProgress: (progress) => events.push(progress) })
    const readingCounts = events
      .filter((event) => event.step === "reading-files")
      .map((event) => event.done ?? -1)
    const parsingCounts = events
      .filter((event) => event.step === "parsing")
      .map((event) => event.done ?? -1)
    const onBoundaryOrFinal = (done: number): boolean =>
      done % 25 === 0 || done === TOTAL_SOURCE_FILES

    // Assert
    expect(readingCounts.length).toBeLessThanOrEqual(maxThrottledEvents)
    expect(parsingCounts.length).toBeLessThanOrEqual(maxThrottledEvents)
    expect(readingCounts.every(onBoundaryOrFinal)).toBe(true)
    expect(parsingCounts.every(onBoundaryOrFinal)).toBe(true)
    expect(readingCounts.at(-1)).toBe(TOTAL_SOURCE_FILES)
    expect(parsingCounts.at(-1)).toBe(TOTAL_SOURCE_FILES)
  })
})
