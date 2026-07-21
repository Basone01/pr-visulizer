// The engine's public API (docs/tauri-architecture.md §4) — platform-NEUTRAL, so it is
// safe to import from the webview: no node builtins are reachable from here. The one
// node-coupled piece (the wasm loader) lives behind the separate `./node` entry.

export type { SessionUser } from "./entities/session.js"

export * from "./services/githubGateway/index.js"
export * from "./services/githubGateway/fixtures/pr42.js"

export * from "./services/repoFiles/index.js"

// Two-way GitHub "Viewed" sync (§11) — driven by the BFF route AND, with no server in the
// picture, by the desktop client, so it lives beside the gateway it wraps.
export * from "./services/viewedSync/index.js"

// The path→language map (pure util) — the desktop's local changed-file list tags each file's
// language client-side, the same mapping the Octokit gateway applies (docs/tauri-architecture.md §6).
export { languageForPath, SUPPORTED_GRAMMAR_IDS } from "./utils/language.js"

// The bounded-concurrency map both engines read files with — also what the desktop batches its
// per-file `git diff` invokes through, so one helper bounds every fan-out over a repo's files.
export { mapWithConcurrency } from "./utils/concurrency.js"

export type {
  AnalysisEngine,
  AnalysisStep,
  AnalysisProgress,
  AnalysisProgressFn,
  AnalyzeOptions,
} from "./services/analysis/engine.js"
export * from "./services/analysis/fastEngine.js"
export * from "./services/analysis/deepEngine.js"
export * from "./services/analysis/analyzeFastSources.js"
export * from "./services/analysis/analyzeDeepSources.js"
export * from "./services/analysis/cache.js"
export * from "./services/analysis/heuristic.js"
export * from "./services/analysis/treeSitter.js"

// deep-v2 precision tier (§6.2). The `typescript`-importing module is NOT re-exported
// here; callers reach it through analyzeDeepFromSources' lazy import.
export * from "./services/analysis/precise/policy.js"
export * from "./services/analysis/precise/referenceIndex.js"
export { mergePreciseEdges } from "./services/analysis/precise/mergePreciseEdges.js"
export type { LibSource } from "./services/analysis/precise/tsLanguageService.js"
