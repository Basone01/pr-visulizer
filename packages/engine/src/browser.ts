// The browser-safe entry (docs/tauri-architecture.md §3/§6): everything a webview or a Web
// Worker needs to run the PURE analysis cores, and nothing that could drag node builtins or
// the Octokit gateway into a browser bundle. The desktop's analysis worker imports from HERE
// (plus `./parser` for the grammar seam) so Vite never walks the full barrel.

export {
  analyzeDeepFromSources,
  DEFAULT_MAX_GHOSTS,
  type DeepSourcesInput,
} from "./services/analysis/analyzeDeepSources.js"
export {
  analyzeFastFromSources,
  type FastSourcesInput,
} from "./services/analysis/analyzeFastSources.js"
export type {
  AnalysisProgress,
  AnalysisProgressFn,
  AnalysisStep,
} from "./services/analysis/engine.js"
export { CORE_GRAMMAR_ID, type GrammarSource } from "./services/analysis/treeSitter.js"
export type { GatewayChangedFile } from "./services/githubGateway/gateway.js"
export {
  DEFAULT_REPO_SCAN,
  type RepoScanSettings,
  scanCandidatePaths,
  withinSizeCap,
} from "./services/repoFiles/repoFiles.js"
export {
  DEFAULT_LIB,
  DEFAULT_PRECISION_POLICY,
  PRECISION_PRESETS,
  type PrecisionPolicy,
  type PrecisionPresetName,
  resolvePrecisionPolicy,
} from "./services/analysis/precise/policy.js"
// Type-only: importing the VALUE would drag `typescript` into the worker's entry chunk.
export type { LibSource } from "./services/analysis/precise/tsLanguageService.js"
