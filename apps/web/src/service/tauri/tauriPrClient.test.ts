// @vitest-environment node
//
// Runs under `node`, not the web project's jsdom, for the same reason as the grammar-source
// parity test: web-tree-sitter's wasm runtime can't be exercised under jsdom (jsdom swaps the
// global Uint8Array and breaks Language.load's bytes-vs-path check). The analysis below is the
// REAL pure deep core over real grammars — only the Worker transport and the Tauri invokes are
// stand-ins (the worker protocol has its own test; the live desktop run proves the spawn).
import {
  CORE_GRAMMAR_ID,
  type GatewayChangedFile,
  type GithubGateway,
  PR42_CONTENTS,
  PR42_FILES,
  PR42_PATHS,
  analyzeDeepFromSources,
  createFakeGithubGateway,
} from "@pr-visulizer/engine"
import { type ChangedFile, type ReviewProgress, reviewProgressSchema } from "@pr-visulizer/shared"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BUNDLED_WASM_URLS, createBrowserGrammarSource } from "@/utils/engineAssets/grammarSource"
import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import type { AnalysisProgress } from "@/entity/analysisProgress"
import type { PrTarget } from "@/entity/pr"
import { CLONE_ROOT_KEY, NeedsRepoSourceError } from "@/entity/repoSource"

import type { RepoSource } from "@/tauri/repoSource"

import { type AnalysisRunner, createTauriPrClient } from "./tauriPrClient"

const requireFromHere = createRequire(import.meta.url)

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`)

  return value
}

// Reverse-map each bundled `?url` asset back to the on-disk wasm the webview would fetch, so
// the browser GrammarSource's fetch reads the exact same bytes as the node loader.
const coreWasmUrl = required(BUNDLED_WASM_URLS[CORE_GRAMMAR_ID], "core wasm url")
const typescriptWasmUrl = required(BUNDLED_WASM_URLS.typescript, "typescript wasm url")
const tsxWasmUrl = required(BUNDLED_WASM_URLS.tsx, "tsx wasm url")

const diskPathByUrl = new Map<string, string>([
  [coreWasmUrl, requireFromHere.resolve("web-tree-sitter/tree-sitter.wasm")],
  [typescriptWasmUrl, requireFromHere.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm")],
  [tsxWasmUrl, requireFromHere.resolve("tree-sitter-wasms/out/tree-sitter-tsx.wasm")],
])

async function readBundledWasm(input: string): Promise<Response> {
  const diskPath = diskPathByUrl.get(input)
  if (!diskPath) throw new Error(`unexpected fetch url in test: ${input}`)

  return new Response(await readFile(diskPath))
}

const PR42: PrTarget = { owner: "acme", repo: "web", number: 42 }

// The repo the deep pipeline reads: PR #42's files plus one UNCHANGED caller of the changed
// middleware — the ghost only a repo-wide analysis can see.
const ADMIN_PATH = "src/api/routes/admin.ts"
const WITH_RATE_LIMIT_ID = `${PR42_PATHS.withRateLimit}#withRateLimit`
const adminSource = `import { withRateLimit } from "../../middleware/withRateLimit.js"

export function adminHandler() {
  const guarded = withRateLimit(() => null)
  return guarded()
}
`

// An in-memory RepoSource standing in for the linked-clone git reads (which need Tauri):
// `files` are the head-tree contents, `changed` the PR's changed set (with patches, the local
// `repo_file_diff` stand-in). `baseReady` toggles the base-diff-available path vs the API
// fallback. Reports the fetch phase like the real one, so the progress sequence is assertable.
function inMemoryRepoSource(
  files: Record<string, string>,
  changed: GatewayChangedFile[],
  baseReady = true
): RepoSource {
  return {
    kind: "linked",

    async prepare(_target, _baseSha, _headSha, onProgress) {
      onProgress?.("fetching")

      return {
        baseReady,
        async listFiles() {
          return Object.keys(files)
        },
        async readFile(path: string) {
          const content = files[path]
          if (content === undefined) throw new Error(`no file at ${path}`)

          return content
        },
        async readMany(paths: string[], onChunk?: (done: number, total: number) => void) {
          onChunk?.(paths.length, paths.length)
          const entries = paths.flatMap((path): Array<[string, string]> => {
            const content = files[path]
            return content === undefined ? [] : [[path, content]]
          })

          return new Map(entries)
        },
        async listChangedFiles(): Promise<ChangedFile[]> {
          return changed.map(({ patch: _patch, ...file }) => file)
        },
        async readFileDiff(path: string): Promise<string> {
          const file = changed.find((entry) => entry.path === path)
          if (!file?.patch) throw new Error(`no diff at ${path}`)

          return file.patch
        },
      }
    },
  }
}

// The pure deep core called in-process — exactly what the Web Worker runs live.
const runPureCore: AnalysisRunner = (sources, onProgress) =>
  analyzeDeepFromSources({
    pr: sources.pr,
    files: sources.files,
    contents: sources.contents,
    grammarSource: createBrowserGrammarSource(),
    ...(onProgress ? { onProgress } : {}),
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("createTauriPrClient — deep-only pipeline (PR #42 fixture)", () => {
  it("runs the deep pipeline automatically on getAnalysis and surfaces the repo-wide ghost", async () => {
    // Arrange
    vi.stubGlobal("fetch", (input: string) => readBundledWasm(String(input)))
    const repoFiles = { ...PR42_CONTENTS, [ADMIN_PATH]: adminSource }
    const client = createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(repoFiles, PR42_FILES),
      runAnalysis: runPureCore,
    })

    // Act — plain getAnalysis: no deepen button, the deep pipeline IS the analysis.
    const response = await client.getAnalysis(PR42, "deep")

    // Assert
    const expectedGhost = { path: ADMIN_PATH, usedChangedSymbols: [WITH_RATE_LIMIT_ID] }
    expect(response.status).toBe("ready")
    if (response.status !== "ready") throw new Error("expected a ready analysis")

    expect(response.result.engine).toBe("deep")
    const adminGhost = response.result.ghosts.find((ghost) => ghost.path === ADMIN_PATH)
    expect(adminGhost).toEqual(expectedGhost)

    const withRateLimitRanked = response.result.ranking.find(
      (ranked) => ranked.path === PR42_PATHS.withRateLimit
    )
    expect(withRateLimitRanked?.blastRadius).toBe(1)
  })

  it("reports the full progressive step sequence through the progress seam", async () => {
    // Arrange
    vi.stubGlobal("fetch", (input: string) => readBundledWasm(String(input)))
    const repoFiles = { ...PR42_CONTENTS, [ADMIN_PATH]: adminSource }
    const client = createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(repoFiles, PR42_FILES),
      runAnalysis: runPureCore,
    })
    const seenSteps: AnalysisProgress["step"][] = []
    client.subscribeAnalysisProgress(PR42, (progress) => seenSteps.push(progress.step))

    // Act
    await client.getAnalysis(PR42, "deep")

    // Assert — the I/O steps come from the client, the CPU steps from the core; dedupe
    // repeats so the assertion reads as the phase order.
    const expectedOrder = ["fetching-pr", "preparing-repo", "reading-files", "resolving", "ranking"]
    const distinctOrder = seenSteps.filter((step, index) => step !== seenSteps[index - 1])
    // "parsing" is throttled (~1 event per 25 files) and this fixture has only 7 — its
    // presence is not guaranteed, so assert the guaranteed steps in order.
    const withoutParsing = distinctOrder.filter((step) => step !== "parsing")
    expect(withoutParsing).toEqual(expectedOrder)
  })

  it("rejects with NeedsRepoSourceError when no repo is linked and no clone root is set", async () => {
    // Arrange — no repoSource override, empty storage: neither a link nor a clone root.
    const client = createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage: createMemoryKeyValueStore(),
    })

    // Act / Assert
    await expect(client.getAnalysis(PR42, "deep")).rejects.toBeInstanceOf(NeedsRepoSourceError)
  })

  it("does NOT reject when a clone root exists — the managed fallback takes over", async () => {
    // Arrange — clone root set, no link: selection must choose managed, whose prepare here
    // fails fast (proving it was reached without any prompt error).
    const storage = createMemoryKeyValueStore()
    await storage.set(CLONE_ROOT_KEY, "/tmp/pr-clones")
    const managedReached = new Error("managed prepare reached")
    const client = createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage,
      cloneManager: {
        prepare: () => Promise.reject(managedReached),
      },
      runAnalysis: runPureCore,
    })

    // Act / Assert
    await expect(client.getAnalysis(PR42, "deep")).rejects.toBe(managedReached)
  })

  it("round-trips review progress through the injected storage", async () => {
    // Arrange
    const client = createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage: createMemoryKeyValueStore(),
    })
    const reviewedFiles = ["src/config/limits.ts"]
    const verdict = "approve" as const

    // Act
    const initial = await client.getProgress(PR42)
    const next: ReviewProgress = { ...initial, reviewedFiles, verdict }
    const saved = await client.putProgress(PR42, next)
    const reloaded = reviewProgressSchema.parse(await client.getProgress(PR42))

    // Assert
    const expected = { reviewedFiles, verdict, headSha: "head0042deadbeef" }
    expect(initial.reviewedFiles).toEqual([])
    expect({
      reviewedFiles: saved.reviewedFiles,
      verdict: saved.verdict,
      headSha: saved.headSha,
    }).toEqual(expected)
    expect({
      reviewedFiles: reloaded.reviewedFiles,
      verdict: reloaded.verdict,
      headSha: reloaded.headSha,
    }).toEqual(expected)
  })
})

// A gateway that counts the HEAVY getPullRequest call, so a test can prove the local-git path
// avoided it (0 calls) or the fallback used it (>=1). Light getPullMeta stays the fake's.
function recordingGateway(): { gateway: GithubGateway; heavyCalls: () => number } {
  const base = createFakeGithubGateway()
  let heavy = 0

  const gateway: GithubGateway = {
    ...base,
    getPullRequest: (target) => {
      heavy += 1
      return base.getPullRequest(target)
    },
  }

  return { gateway, heavyCalls: () => heavy }
}

describe("createTauriPrClient — local git diff (deep path)", () => {
  const httpFile = PR42_FILES.find((file) => file.path === PR42_PATHS.http)
  if (!httpFile?.patch) throw new Error("fixture: http file must carry a patch")

  it("serves getPatch from the local file diff, never the heavy API call", async () => {
    // Arrange
    const { gateway, heavyCalls } = recordingGateway()
    const client = createTauriPrClient({
      gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(PR42_CONTENTS, PR42_FILES),
    })
    const path = PR42_PATHS.http

    // Act
    const patch = await client.getPatch(PR42, path)

    // Assert — the local readFileDiff patch, and getPullRequest was never paginated.
    const expectedPatch = httpFile.patch
    expect(patch).toBe(expectedPatch)
    expect(heavyCalls()).toBe(0)
  })

  it("builds getOverview from light meta + the local changed-file list", async () => {
    // Arrange
    const { gateway, heavyCalls } = recordingGateway()
    const client = createTauriPrClient({
      gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(PR42_CONTENTS, PR42_FILES),
    })

    // Act
    const overview = await client.getOverview(PR42)

    // Assert — meta from the light call, file list from local git (no heavy call, no patches).
    const expectedHeadSha = "head0042deadbeef"
    const expectedPaths = PR42_FILES.map((file) => file.path)
    expect(overview.pr.headSha).toBe(expectedHeadSha)
    expect(overview.files.map((file) => file.path)).toEqual(expectedPaths)
    expect(heavyCalls()).toBe(0)
  })

  it("falls back to the API patch when the base object is unavailable", async () => {
    // Arrange — baseReady false: the local base...head diff can't be computed.
    const { gateway, heavyCalls } = recordingGateway()
    const baseUnavailable = inMemoryRepoSource(PR42_CONTENTS, PR42_FILES, false)
    const client = createTauriPrClient({
      gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: baseUnavailable,
    })
    const path = PR42_PATHS.http

    // Act
    const patch = await client.getPatch(PR42, path)

    // Assert — same patch, but sourced from the API fallback (getPullRequest was called).
    const expectedPatch = httpFile.patch
    expect(patch).toBe(expectedPatch)
    expect(heavyCalls()).toBeGreaterThanOrEqual(1)
  })

  it("reads the changed files' diffs concurrently, keeping each patch on its own file", async () => {
    // Arrange — a repo source whose readFileDiff is slow enough to overlap, and counts how
    // many diffs are in flight at once. Sequential reads would never exceed 1.
    let inFlight = 0
    let maxInFlight = 0
    const base = inMemoryRepoSource(PR42_CONTENTS, PR42_FILES)
    const slowDiffSource: RepoSource = {
      kind: "linked",
      async prepare(target, baseSha, headSha, onProgress) {
        const prepared = await base.prepare(target, baseSha, headSha, onProgress)

        return {
          ...prepared,
          async readFileDiff(path: string): Promise<string> {
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 5))
            inFlight -= 1

            return prepared.readFileDiff(path)
          },
        }
      },
    }

    // The pure core is irrelevant here — capture the changed-file set it is handed instead.
    let analyzed: GatewayChangedFile[] = []
    const captureFiles: AnalysisRunner = (sources) => {
      analyzed = sources.files
      return Promise.resolve({
        engine: "deep",
        pr: sources.pr,
        files: [],
        symbols: [],
        edges: [],
        ranking: [],
        ghosts: [],
        occurrences: [],
      })
    }

    const client = createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage: createMemoryKeyValueStore(),
      repoSource: slowDiffSource,
      runAnalysis: captureFiles,
    })

    // Act
    await client.getAnalysis(PR42, "deep")

    // Assert — every modified/renamed file kept its OWN patch (added/deleted carry none, as
    // before), and the reads overlapped rather than running one at a time.
    const needsPatch = (status: string): boolean => status === "modified" || status === "renamed"
    const expectedPatchByPath = new Map(
      PR42_FILES.filter((file) => needsPatch(file.status)).map((file) => [file.path, file.patch])
    )
    const actualPatchByPath = new Map(
      analyzed.filter((file) => file.patch !== null).map((file) => [file.path, file.patch])
    )
    expect(actualPatchByPath).toEqual(expectedPatchByPath)
    expect(maxInFlight).toBeGreaterThan(1)
  })
})
