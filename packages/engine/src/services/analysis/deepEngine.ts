import { type AnalysisResult, type RankingPolicy, resolveRankingPolicy } from "@pr-visulizer/shared"

import { throttleByCount } from "../../utils/progressThrottle.js"
import type { GithubGateway, PrTarget } from "../githubGateway/index.js"
import {
  DEFAULT_REPO_SCAN,
  type RepoFiles,
  type RepoScanSettings,
  readRepoSources,
} from "../repoFiles/index.js"
import { DEFAULT_MAX_GHOSTS, analyzeDeepFromSources } from "./analyzeDeepSources.js"
import { type AnalysisCache, createAnalysisCache } from "./cache.js"
import type { AnalysisEngine, AnalyzeOptions } from "./engine.js"
import { type GrammarSource } from "./treeSitter.js"

// DeepAstEngine — deep-engine v1 (docs/architecture.md §6). This module is the thin I/O
// WRAPPER: it fetches PR meta (steps 1–2) and reads the WHOLE checkout at headSha through
// the RepoFiles seam, then hands the read `contents` map to the pure `analyzeDeepFromSources`
// core (analyzeDeepSources.ts). The pure core carries the repo-wide CPU pipeline, so the
// desktop app runs that identical analysis inside a browser Web Worker.

// Repo-wide reading counts run into the thousands, so the reading progress is throttled to
// one every ~25 files (§6) — mirrors the pure core's parsing throttle.
const DEEP_PROGRESS_THROTTLE = 25

// Controllable core (architecture style): the deep scan settings plus the ghost cap, each
// a knob with a default. Callers override individual fields via `limits`.
export type DeepEngineLimits = RepoScanSettings & {
  // Cap the ghost list — deep results are big and ghosts are context, not work (§6).
  maxGhosts: number
}

export const DEFAULT_DEEP_LIMITS: DeepEngineLimits = {
  ...DEFAULT_REPO_SCAN,
  maxGhosts: DEFAULT_MAX_GHOSTS,
}

function resolveDeepLimits(overrides?: Partial<DeepEngineLimits>): DeepEngineLimits {
  return { ...DEFAULT_DEEP_LIMITS, ...overrides }
}

export type DeepEngineDeps = {
  gateway: GithubGateway
  // The checkout at `headSha` — the desktop guarantees it matches; the engine asserts
  // nothing about git, it only reads paths (§6).
  repoFiles: RepoFiles
  grammarSource: GrammarSource
  cache?: AnalysisCache
  policy?: RankingPolicy
  limits?: Partial<DeepEngineLimits>
}

export function createDeepEngine(deps: DeepEngineDeps): AnalysisEngine {
  const { gateway, repoFiles } = deps
  const cache = deps.cache ?? createAnalysisCache()
  const policy = deps.policy ?? resolveRankingPolicy()
  const limits = resolveDeepLimits(deps.limits)
  const name = "deep" as const

  async function analyze(target: PrTarget, options?: AnalyzeOptions): Promise<AnalysisResult> {
    const report = options?.onProgress

    // Steps 1–2: PR meta + changed files (with patches) — same source as fast (§6).
    report?.({ step: "fetching-pr" })
    const { pr, files } = await gateway.getPullRequest(target)

    const cached = cache.get(pr.headSha, name)
    if (cached) return cached

    // Read the WHOLE repo at headSha, defensively (skip vendored/oversized/unreadable).
    // Repo-wide counts are throttled so the reading-files step reports smoothly, not per file.
    const readProgress = report
      ? throttleByCount(DEEP_PROGRESS_THROTTLE, (done, total) =>
          report({ step: "reading-files", done, total })
        )
      : undefined
    const { contents } = await readRepoSources(repoFiles, limits, readProgress)

    // The pure CPU core (analyzeDeepSources.ts) — no I/O from here on.
    const result = await analyzeDeepFromSources({
      pr,
      files,
      contents,
      grammarSource: deps.grammarSource,
      maxGhosts: limits.maxGhosts,
      policy,
      ...(report ? { onProgress: report } : {}),
    })

    cache.set(pr.headSha, name, result)
    return result
  }

  return { name, analyze }
}
