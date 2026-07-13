import { type AnalysisResult, type RankingPolicy, resolveRankingPolicy } from "@pr-visulizer/shared"

import { mapWithConcurrency } from "../../utils/concurrency.js"
import type { GatewayChangedFile, GithubGateway, PrTarget } from "../githubGateway/index.js"
import { analyzeFastFromSources } from "./analyzeFastSources.js"
import { type AnalysisCache, createAnalysisCache } from "./cache.js"
import type { AnalysisEngine, AnalyzeOptions } from "./engine.js"
import { type GrammarSource } from "./treeSitter.js"

// FastAstEngine — the default in-process AST pipeline (docs/architecture.md §5). This module
// is now the thin I/O WRAPPER: it fetches PR meta + changed-file content through the gateway
// (steps 1–3), then hands the read sources to the pure `analyzeFastFromSources` core (steps
// 4–9, analyzeFastSources.ts). The pure core carries the CPU pipeline, so the very same
// analysis runs in a browser Web Worker with the main thread doing these fetches.

// Controllable core (architecture style): the one knob the fast pipeline legitimately needs,
// with a sane default. Callers override individual fields via `limits`.
export type FastEngineLimits = {
  // Bounded concurrency for the changed-file content fetches (§5 step 3). Default 6 — enough
  // to hide network latency, few enough to stay polite to the GitHub API and never open a
  // socket per file on a 300-file PR.
  fetchConcurrency: number
}

export const DEFAULT_FAST_LIMITS: FastEngineLimits = {
  fetchConcurrency: 6,
}

function resolveFastLimits(overrides?: Partial<FastEngineLimits>): FastEngineLimits {
  return { ...DEFAULT_FAST_LIMITS, ...overrides }
}

export type FastEngineDeps = {
  gateway: GithubGateway
  // The platform's wasm loader (§3 seam) — REQUIRED, and the only thing that differs
  // between the node BFF and the webview. No default: a default would bind this
  // browser-safe module to a node loader and drag node builtins into the webview.
  grammarSource: GrammarSource
  cache?: AnalysisCache
  policy?: RankingPolicy
  limits?: Partial<FastEngineLimits>
}

// § step 3: fetch every changed file's head content with BOUNDED concurrency (was one-at-a-
// time, the reported slow path). A deleted file has no head content — it resolves instantly.
// `onRead` reports the running done/total as each fetch settles, feeding the reading-files
// progress step. Results stay in `files` order regardless of completion order.
function fetchContents(
  gateway: GithubGateway,
  target: PrTarget,
  headSha: string,
  files: GatewayChangedFile[],
  concurrency: number,
  onRead?: (done: number, total: number) => void
): Promise<Array<string | undefined>> {
  return mapWithConcurrency(
    files,
    concurrency,
    (file) =>
      file.status === "deleted"
        ? Promise.resolve(undefined)
        : gateway.getFileContent(target, file.path, headSha),
    onRead ? (done) => onRead(done, files.length) : undefined
  )
}

export function createFastAstEngine(deps: FastEngineDeps): AnalysisEngine {
  const { gateway } = deps
  const cache = deps.cache ?? createAnalysisCache()
  const policy = deps.policy ?? resolveRankingPolicy()
  const limits = resolveFastLimits(deps.limits)
  const name = "fast" as const

  async function analyze(target: PrTarget, options?: AnalyzeOptions): Promise<AnalysisResult> {
    const report = options?.onProgress

    // Steps 1–2: PR meta + changed files (with patches).
    report?.({ step: "fetching-pr" })
    const { pr, files } = await gateway.getPullRequest(target)

    // Step 9's cache is checked BEFORE the heavy parse — immutable per headSha.
    const cached = cache.get(pr.headSha, name)
    if (cached) return cached

    // Step 3: fetch content with bounded concurrency (reading-files progress).
    const contents = await fetchContents(
      gateway,
      target,
      pr.headSha,
      files,
      limits.fetchConcurrency,
      report ? (done, total) => report({ step: "reading-files", done, total }) : undefined
    )

    // Steps 4–9: the pure CPU core (analyzeFastSources.ts) — no I/O from here on.
    const result = await analyzeFastFromSources({
      pr,
      files,
      contents,
      grammarSource: deps.grammarSource,
      policy,
      ...(report ? { onProgress: report } : {}),
    })

    // Step 9: cache the immutable result.
    cache.set(pr.headSha, name, result)
    return result
  }

  return { name, analyze }
}
