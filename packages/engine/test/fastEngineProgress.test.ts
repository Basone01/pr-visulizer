import { describe, expect, it } from "vitest"

import {
  type AnalysisProgress,
  type GithubGateway,
  PR42_META,
  createFakeGithubGateway,
  createFastAstEngine,
} from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// The fast engine now reports progressive steps and fetches changed-file contents with bounded
// concurrency (docs/architecture.md §5). Both are verified against the PR #42 fixture (6
// changed TS files) with a fresh engine per test so its per-headSha cache never short-circuits
// the pipeline being measured.

const target = { owner: PR42_META.owner, repo: PR42_META.repo, number: PR42_META.number }

// Collapse a repeated step to its first appearance so the phase ORDER is comparable regardless
// of how many counted sub-events a phase emits.
function distinctOrder(steps: string[]): string[] {
  return steps.filter((step, index, all) => step !== all[index - 1])
}

describe("createFastAstEngine — progress events (PR #42 fixture)", () => {
  it("reports the phases in order, ending on ranking", async () => {
    // Arrange
    const engine = createFastAstEngine({
      gateway: createFakeGithubGateway(),
      grammarSource: createNodeGrammarSource(),
    })
    const events: AnalysisProgress[] = []
    const expectedOrder = ["fetching-pr", "reading-files", "parsing", "resolving", "ranking"]

    // Act
    await engine.analyze(target, { onProgress: (progress) => events.push(progress) })
    const actualOrder = distinctOrder(events.map((event) => event.step))

    // Assert
    expect(actualOrder).toEqual(expectedOrder)
  })

  it("counts reading-files and parsing up to the 6 changed files", async () => {
    // Arrange
    const engine = createFastAstEngine({
      gateway: createFakeGithubGateway(),
      grammarSource: createNodeGrammarSource(),
    })
    const events: AnalysisProgress[] = []

    // Act
    await engine.analyze(target, { onProgress: (progress) => events.push(progress) })
    const lastReading = events.filter((event) => event.step === "reading-files").at(-1)
    const lastParsing = events.filter((event) => event.step === "parsing").at(-1)

    // Assert
    const expectedReading = { step: "reading-files", done: 6, total: 6 }
    const expectedParsing = { step: "parsing", done: 6, total: 6 }
    expect(lastReading).toEqual(expectedReading)
    expect(lastParsing).toEqual(expectedParsing)
  })
})

// A gateway whose getFileContent is slow and tracks how many fetches overlap — the proof that
// content fetches run concurrently (was one-at-a-time) but never exceed the configured pool.
function overlapTrackingGateway(): { gateway: GithubGateway; maxInFlight: () => number } {
  const base = createFakeGithubGateway()
  let inFlight = 0
  let maxInFlight = 0

  const gateway: GithubGateway = {
    ...base,
    async getFileContent(fetchTarget, path, sha): Promise<string> {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)

      await new Promise((resolve) => setTimeout(resolve, 10))
      const content = await base.getFileContent(fetchTarget, path, sha)

      inFlight -= 1
      return content
    },
  }

  return { gateway, maxInFlight: () => maxInFlight }
}

describe("createFastAstEngine — bounded-concurrency fetches", () => {
  it("overlaps fetches but caps them at the fetchConcurrency limit", async () => {
    // Arrange
    const fetchConcurrency = 3
    const { gateway, maxInFlight } = overlapTrackingGateway()
    const engine = createFastAstEngine({
      gateway,
      grammarSource: createNodeGrammarSource(),
      limits: { fetchConcurrency },
    })

    // Act
    await engine.analyze(target)
    const peak = maxInFlight()

    // Assert — real parallelism (more than one at a time) that respects the pool size.
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(fetchConcurrency)
  })
})
