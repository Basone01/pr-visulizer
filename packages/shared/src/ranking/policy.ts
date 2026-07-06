// Ranking is a controllable core with presets (docs/architecture.md §8.3,
// AGENTS.architecture.md). The sort priorities live in ONE config object, not
// scattered in code; presets are named data; a caller may override any setting.

export type RankingPrimary = "topoLevel" | "fanIn" | "churnAsc"
export type RankingTieBreaker = "topoLevel" | "fanIn" | "churn" | "path"

export type RankingPolicy = {
  primary: RankingPrimary
  tieBreakers: RankingTieBreaker[]
}

// Presets are data — a named bundle of settings for a common case.
export const RANKING_PRESETS = {
  "foundations-first": { primary: "topoLevel", tieBreakers: ["fanIn", "churn", "path"] },
  "blast-radius-first": { primary: "fanIn", tieBreakers: ["topoLevel", "churn", "path"] },
  "quick-wins": { primary: "churnAsc", tieBreakers: ["topoLevel", "fanIn", "path"] },
} satisfies Record<string, RankingPolicy>

export type RankingPresetName = keyof typeof RANKING_PRESETS

// Defaults layer — the base every resolution falls back to (§8.3: foundations-first).
export const DEFAULT_RANKING_POLICY: RankingPolicy = RANKING_PRESETS["foundations-first"]

// Resolve the effective policy: defaults ← preset ← overrides (later wins).
// The three entry points of the controllable-core shape collapse here — a preset
// name (simple), explicit overrides (full control), or a preset + overrides (common).
export function resolveRankingPolicy(
  preset: RankingPresetName = "foundations-first",
  overrides: Partial<RankingPolicy> = {}
): RankingPolicy {
  return { ...DEFAULT_RANKING_POLICY, ...RANKING_PRESETS[preset], ...overrides }
}
