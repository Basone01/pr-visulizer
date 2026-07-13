// The analysis-progress signal surfaced to the progressive shell (docs/architecture.md §5,
// task 4/5). The engine emits these steps as it runs; the tauri client relays them from the
// in-webview engine callback, and the fixture client emits a synthetic sequence so the
// progressive shell is exercisable in dev. Defined here as the SPA's OWN entity (like
// viewModels mirrors the wire contract) so the PrClient interface can depend on it WITHOUT
// importing the engine package — the shape is structurally identical to the engine's, so the
// tauri client passes engine progress straight through.

// "preparing-repo" is the desktop-only extra step (docs/tauri-architecture.md §6): the
// RepoSource's clone/fetch phase, reported between fetching-pr and reading-files. It is a
// SUPERSET of the engine's step union, so engine progress passes straight through.
export type AnalysisStep =
  | "fetching-pr"
  | "preparing-repo"
  | "reading-files"
  | "parsing"
  | "resolving"
  | "ranking"
  // deep-v2 only (§6.2): the compiler-grade pass. Emitted after ranking, and only when the
  // precision tier is enabled — a disabled tier never reports it.
  | "precise-linking"

export type AnalysisProgress = {
  step: AnalysisStep
  done?: number
  total?: number
  // A live sub-status for long steps — git's own progress lines during a first clone
  // ("Receiving objects 42%") — so a multi-minute prepare never reads as stuck.
  detail?: string
}

export type AnalysisProgressListener = (progress: AnalysisProgress) => void

// The full step list, in order — the progress panel renders every step and highlights the
// current one (full-list-with-current-highlighted, §5 task 4).
export const ANALYSIS_STEPS: AnalysisStep[] = [
  "fetching-pr",
  "preparing-repo",
  "reading-files",
  "parsing",
  "resolving",
  "ranking",
]

// deep-v2 only: the desktop's step list WITH the compiler-grade pass. The precision tier is
// opt-in, so a tier-off run must never render a "precise linking" step that never runs — the
// shell picks this list only when the policy is enabled.
export const DEEP_V2_ANALYSIS_STEPS: AnalysisStep[] = [...ANALYSIS_STEPS, "precise-linking"]

// Browser modes (BFF / fixture) never prepare a local repo — their panel renders the engine's
// own five steps only.
export const BROWSER_ANALYSIS_STEPS: AnalysisStep[] = ANALYSIS_STEPS.filter(
  (step) => step !== "preparing-repo"
)

// The human label per step. Kept next to the union so a new step forces a label.
export const ANALYSIS_STEP_LABEL: Record<AnalysisStep, string> = {
  "fetching-pr": "fetching PR",
  "preparing-repo": "preparing repo",
  "reading-files": "reading files",
  parsing: "parsing",
  resolving: "resolving",
  ranking: "ranking",
  "precise-linking": "precise linking",
}
