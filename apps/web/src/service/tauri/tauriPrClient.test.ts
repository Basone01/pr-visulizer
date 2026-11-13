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

import {
  MAX_CODEX_SAFE_PROFILE_PATCH_RESPONSE_BYTES,
  assembleBoundedRevisionPinnedPatches,
} from "@/service/aiReview/codexReviewContext"

import type { RepoSource } from "@/tauri/repoSource"

import { type PrClient, RevisionPinnedPatchError } from "../prClient"
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
    const expectedGhost = {
      path: ADMIN_PATH,
      usedChangedSymbols: [WITH_RATE_LIMIT_ID],
      usesChangedFiles: [PR42_PATHS.withRateLimit],
    }
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

  it("revision_pinned_patch_snapshot_rejects_pr_revision_change_during_context_assembly", async () => {
    // Arrange — the first identity read admits the requested revision; the post-read check sees
    // a force-push, which must reject the whole snapshot instead of returning mixed patches.
    const base = createFakeGithubGateway()
    let metaReads = 0
    const gateway: GithubGateway = {
      ...base,
      async getPullMeta(target) {
        metaReads += 1
        const meta = await base.getPullMeta(target)
        return metaReads === 1 ? meta : { ...meta, headSha: "force-pushed-head" }
      },
    }
    const client = createTauriPrClient({
      gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(PR42_CONTENTS, PR42_FILES),
    })

    // Act
    const snapshot = client.getRevisionPinnedPatchSnapshot(PR42, {
      baseSha: "base0042cafebabe",
      headSha: "head0042deadbeef",
      paths: [PR42_PATHS.http],
    })

    // Assert
    await expect(snapshot).rejects.toThrow(
      "PR revisions changed while collecting the revision-pinned patch snapshot"
    )
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

// The Rust `repo_file_diff` cap crosses the invoke boundary as this bare string (lib.rs).
const NATIVE_CAP_REFUSAL = "git diff exceeded the bounded patch byte limit"

// The changed-file set and the content reads the analysis made, for the skipped-file tests.
type AnalysisReads = {
  analyzedFiles: GatewayChangedFile[]
  contentPaths: string[]
  patchPaths: string[]
}

// PR #42's repo source, with extra changed files, and paths whose diff read fails the way
// the native command does (the cap, invalid UTF-8). Records every patch and content read the analysis asks for.
function skippingRepoSource(input: {
  extraChanged: GatewayChangedFile[]
  extraContents: Record<string, string>
  // path -> the bare string its `repo_file_diff` rejects with
  failingDiffs: Record<string, string>
  reads: AnalysisReads
}): RepoSource {
  const base = inMemoryRepoSource({ ...PR42_CONTENTS, ...input.extraContents }, [
    ...PR42_FILES,
    ...input.extraChanged,
  ])

  return {
    kind: "linked",
    async prepare(target, baseSha, headSha, onProgress) {
      const prepared = await base.prepare(target, baseSha, headSha, onProgress)

      return {
        ...prepared,
        async readMany(paths: string[], onChunk?: (done: number, total: number) => void) {
          input.reads.contentPaths.push(...paths)
          return prepared.readMany(paths, onChunk)
        },
        async readFileDiff(path: string): Promise<string> {
          input.reads.patchPaths.push(path)
          const failure = input.failingDiffs[path]
          if (failure !== undefined) return Promise.reject(failure)

          return prepared.readFileDiff(path)
        },
      }
    },
  }
}

function capturingRunner(reads: AnalysisReads): AnalysisRunner {
  return (sources) => {
    reads.analyzedFiles = sources.files
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
}

describe("createTauriPrClient — generated files and omitted diffs never block the analysis", () => {
  function clientFor(input: Parameters<typeof skippingRepoSource>[0]) {
    return createTauriPrClient({
      gateway: createFakeGithubGateway(),
      storage: createMemoryKeyValueStore(),
      repoSource: skippingRepoSource(input),
      runAnalysis: capturingRunner(input.reads),
    })
  }

  it("a hand-written file over the patch cap does not fail the analysis: its content is still read and its diff is recorded as omitted", async () => {
    // Arrange
    const overCapFile = required(
      PR42_FILES.find((file) => file.status === "modified"),
      "a modified PR #42 file"
    )
    const reads: AnalysisReads = { analyzedFiles: [], contentPaths: [], patchPaths: [] }
    const client = clientFor({
      extraChanged: [],
      extraContents: {},
      failingDiffs: { [overCapFile.path]: NATIVE_CAP_REFUSAL },
      reads,
    })

    // Act
    const response = await client.getAnalysis(PR42, "deep")

    // Assert
    const analyzed = reads.analyzedFiles.find((file) => file.path === overCapFile.path)
    const expected = {
      status: "ready",
      generated: undefined,
      omissions: [
        { path: overCapFile.path, part: "diff", reason: "too-large", limitBytes: 131072 },
      ],
      contentRead: true,
    }
    expect({
      status: response.status,
      generated: analyzed?.skip,
      omissions: analyzed?.omissions,
      contentRead: reads.contentPaths.includes(overCapFile.path),
    }).toEqual(expected)
  })

  it("any other per-file diff failure is recorded as unreadable instead of failing the analysis", async () => {
    // Arrange
    const legacyPath = "legacy/report.php"
    const legacyFile: GatewayChangedFile = {
      path: legacyPath,
      status: "modified",
      additions: 3,
      deletions: 3,
      language: "php",
      patch: null,
    }
    const notUtf8 = "git diff was not valid UTF-8"
    const reads: AnalysisReads = { analyzedFiles: [], contentPaths: [], patchPaths: [] }
    const client = clientFor({
      extraChanged: [legacyFile],
      extraContents: { [legacyPath]: "<?php echo 1;" },
      failingDiffs: { [legacyPath]: notUtf8 },
      reads,
    })

    // Act
    const response = await client.getAnalysis(PR42, "deep")

    // Assert
    const expected = {
      status: "ready",
      omissions: [{ path: legacyPath, part: "diff", reason: "unreadable", message: notUtf8 }],
    }
    expect({
      status: response.status,
      omissions: reads.analyzedFiles.find((file) => file.path === legacyPath)?.omissions,
    }).toEqual(expected)
  })

  it("checks the cap for an added file too", async () => {
    // Arrange
    const addedPath = "src/server/bigNewModule.ts"
    const addedFile: GatewayChangedFile = {
      path: addedPath,
      status: "added",
      additions: 9000,
      deletions: 0,
      language: "typescript",
      patch: null,
    }
    const reads: AnalysisReads = { analyzedFiles: [], contentPaths: [], patchPaths: [] }
    const client = clientFor({
      extraChanged: [addedFile],
      extraContents: { [addedPath]: "export const big = 1" },
      failingDiffs: { [addedPath]: NATIVE_CAP_REFUSAL },
      reads,
    })

    // Act
    await client.getAnalysis(PR42, "deep")

    // Assert
    const expected = [{ path: addedPath, part: "diff", reason: "too-large", limitBytes: 131072 }]
    expect(reads.analyzedFiles.find((file) => file.path === addedPath)?.omissions).toEqual(expected)
  })

  it("a file generated by its name is never asked for a patch and its content is never read", async () => {
    // Arrange
    const generatedPath = "public/build/app.min.js"
    const generatedFile: GatewayChangedFile = {
      path: generatedPath,
      status: "modified",
      additions: 1,
      deletions: 1,
      language: "javascript",
      patch: "@@ -1 +1 @@\n-var a=1\n+var a=2\n",
    }
    const reads: AnalysisReads = { analyzedFiles: [], contentPaths: [], patchPaths: [] }
    const client = clientFor({
      extraChanged: [generatedFile],
      extraContents: { [generatedPath]: "var a=2" },
      failingDiffs: {},
      reads,
    })

    // Act
    await client.getAnalysis(PR42, "deep")

    // Assert
    const expected = {
      patchRead: false,
      contentRead: false,
      skip: { path: generatedPath, reason: "generated" },
    }
    expect({
      patchRead: reads.patchPaths.includes(generatedPath),
      contentRead: reads.contentPaths.includes(generatedPath),
      skip: reads.analyzedFiles.find((file) => file.path === generatedPath)?.skip,
    }).toEqual(expected)
  })
})

// The desktop half of the refresh button. PR meta and the prepared repo are memoized per PR
// with NO head SHA in the key, so without an explicit drop a desktop refresh would keep
// re-serving the head the app opened on, however many times the SPA refetched.
describe("createTauriPrClient — invalidatePr", () => {
  function countingGateway(): { gateway: GithubGateway; metaReads: () => number } {
    const inner = createFakeGithubGateway()
    let reads = 0

    return {
      gateway: {
        ...inner,
        getPullMeta: (target) => {
          reads += 1
          return inner.getPullMeta(target)
        },
      },
      metaReads: () => reads,
    }
  }

  it("re-reads the PR from GitHub on the next call, where a repeat read is memoized", async () => {
    // Arrange
    const { gateway, metaReads } = countingGateway()
    const client = createTauriPrClient({
      gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(PR42_CONTENTS, PR42_FILES),
    })

    // Act
    await client.getOverview(PR42)
    await client.getOverview(PR42)
    const memoizedReads = metaReads()

    await client.invalidatePr(PR42)
    await client.getOverview(PR42)

    // Assert — two opens cost one read; the drop makes the third one hit GitHub again.
    const expected = { memoizedReads: 1, readsAfterInvalidate: 2 }
    expect({ memoizedReads, readsAfterInvalidate: metaReads() }).toEqual(expected)
  })
})

// The AI review seam: the bounded assembler reading through PrClient, and nothing else. Its own
// rule is that no requested path may fall back to the gateway's paginated full-PR response — the
// desktop client's display `getPatch` still holds that fallback, and the AI path must not reach it
// however the local revision-pinned reader fails.
describe("createTauriPrClient — AI revision-pinned patch reader", () => {
  const httpFile = PR42_FILES.find((file) => file.path === PR42_PATHS.http)
  const loginFile = PR42_FILES.find((file) => file.path === PR42_PATHS.login)
  if (!httpFile?.patch || !loginFile?.patch) {
    throw new Error("fixture: the modified files must carry patches")
  }

  const BASE_SHA = "base0042cafebabe"
  const HEAD_SHA = "head0042deadbeef"

  // The Rust `repo_file_diff` cap refuses over-limit bytes BEFORE UTF-8 conversion
  // (apps/desktop/src-tauri/src/lib.rs, pinned there by its own
  // repo_file_diff_enforces_byte_cap_before_utf8_conversion test) and `invoke` surfaces that
  // refusal as a BARE STRING, never an Error — which is what this reproduces.
  const GIT_DIFF_BYTE_CAP_REJECTION = "git diff exceeded the bounded patch byte limit"

  // Exactly how AppShell's createCodexSafeProfileLaunchContext drives the seam: the real bounded
  // assembler over the real client's getRevisionPinnedPatchSnapshot, one path per request.
  function assembleAiContextPatches(client: PrClient, paths: readonly string[]) {
    return assembleBoundedRevisionPinnedPatches({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      paths,
      maxResponseBytes: MAX_CODEX_SAFE_PROFILE_PATCH_RESPONSE_BYTES,
      loadSnapshot: (requestedPaths) =>
        client.getRevisionPinnedPatchSnapshot(PR42, {
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
          paths: requestedPaths,
        }),
    })
  }

  function byteCappedRepoSource(oversizedPath: string): RepoSource {
    const local = inMemoryRepoSource(PR42_CONTENTS, PR42_FILES)

    return {
      kind: "linked",
      async prepare(target, baseSha, headSha, onProgress) {
        const prepared = await local.prepare(target, baseSha, headSha, onProgress)

        return {
          ...prepared,
          readFileDiff: (path: string) =>
            path === oversizedPath
              ? Promise.reject(GIT_DIFF_BYTE_CAP_REJECTION)
              : prepared.readFileDiff(path),
        }
      },
    }
  }

  // A force push landing between the reader's two identity reads.
  function forcePushAfterFirstMetaRead(): GithubGateway {
    const base = createFakeGithubGateway()
    let metaReads = 0

    return {
      ...base,
      async getPullMeta(target) {
        metaReads += 1
        const meta = await base.getPullMeta(target)

        return metaReads === 1 ? meta : { ...meta, headSha: "force-pushed-head" }
      },
    }
  }

  it("ai_revision_pinned_api_patch_reader_never_materializes_unbounded_full_pr_response", async () => {
    // Arrange
    const contextPaths = [PR42_PATHS.login, PR42_PATHS.http]
    const oversizedPath = PR42_PATHS.login
    const admittedPath = PR42_PATHS.http
    const noRepoSource = recordingGateway()
    const noRepoSourceClient = createTauriPrClient({
      gateway: noRepoSource.gateway,
      storage: createMemoryKeyValueStore(),
    })
    const baseUnavailable = recordingGateway()
    const baseUnavailableClient = createTauriPrClient({
      gateway: baseUnavailable.gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(PR42_CONTENTS, PR42_FILES, false),
    })
    const byteCapped = recordingGateway()
    const byteCappedClient = createTauriPrClient({
      gateway: byteCapped.gateway,
      storage: createMemoryKeyValueStore(),
      repoSource: byteCappedRepoSource(oversizedPath),
    })
    const forcePushedClient = createTauriPrClient({
      gateway: forcePushAfterFirstMetaRead(),
      storage: createMemoryKeyValueStore(),
      repoSource: inMemoryRepoSource(PR42_CONTENTS, PR42_FILES),
    })

    // Act
    const withoutRepoSource = await assembleAiContextPatches(noRepoSourceClient, contextPaths)
    const withoutLocalBase = await assembleAiContextPatches(baseUnavailableClient, contextPaths)
    const heavyCallsAfterAiReads = baseUnavailable.heavyCalls()
    // The DISPLAY fallback on that same client, to prove the counter above can move at all.
    const displayPatch = await baseUnavailableClient.getPatch(PR42, admittedPath)
    const heavyCallsAfterDisplayRead = baseUnavailable.heavyCalls()
    const overLimitBytes = await assembleAiContextPatches(byteCappedClient, contextPaths)
    const forcePushedFailure = await assembleAiContextPatches(forcePushedClient, contextPaths).then(
      () => null,
      (error: unknown) => error
    )

    // Assert
    const unavailableOmissions = [
      { path: oversizedPath, reason: "patch-unavailable" },
      { path: admittedPath, reason: "patch-unavailable" },
    ]
    const expected = {
      // No repo source and no local base are DISCLOSED omissions, never a full-PR read.
      withoutRepoSource: { patches: {}, omissions: unavailableOmissions },
      withoutLocalBase: { patches: {}, omissions: unavailableOmissions },
      aiHeavyCalls: 0,
      byteCappedHeavyCalls: 0,
      // Over-limit Git bytes are refused before any patch string exists for that path.
      overLimitBytes: {
        patches: { [admittedPath]: httpFile.patch },
        omissions: [{ path: oversizedPath, reason: "patch-byte-limit" }],
      },
      // A revision change aborts the WHOLE assembly; it is never disclosed as an omission.
      forcePushedFailure: { reason: "revision-changed", omissions: undefined },
    }
    expect({
      withoutRepoSource: {
        patches: withoutRepoSource.patches,
        omissions: withoutRepoSource.omissions,
      },
      withoutLocalBase: {
        patches: withoutLocalBase.patches,
        omissions: withoutLocalBase.omissions,
      },
      aiHeavyCalls: noRepoSource.heavyCalls() + heavyCallsAfterAiReads,
      byteCappedHeavyCalls: byteCapped.heavyCalls(),
      overLimitBytes: { patches: overLimitBytes.patches, omissions: overLimitBytes.omissions },
      forcePushedFailure: {
        reason:
          forcePushedFailure instanceof RevisionPinnedPatchError ? forcePushedFailure.reason : null,
        omissions: (forcePushedFailure as { omissions?: unknown }).omissions,
      },
    }).toEqual(expected)
    expect(displayPatch).toBe(httpFile.patch)
    expect(heavyCallsAfterDisplayRead).toBeGreaterThanOrEqual(1)
  })
})
