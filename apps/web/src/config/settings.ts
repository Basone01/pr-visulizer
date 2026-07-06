import type { RankingPresetName } from "@pr-visulizer/shared"

// Controllable core with sane defaults (AGENTS.architecture.md). Everything that
// varies lives here as a setting; the rest of the app reads AppSettings, never a
// hardcoded magic number.
export type AppSettings = {
  // Definitions longer than this (in lines) truncate in the peek popup with a fade
  // and a "Show N more" action (docs/architecture.md §10). Default 15.
  peekMaxLines: number

  // How many lines a truncated peek shows before the fade. §10: "first 10 lines".
  peekPreviewLines: number

  // Which ranking preset the review order uses (§8.3). Default foundations-first.
  rankingPreset: RankingPresetName
}

export const DEFAULT_SETTINGS: AppSettings = {
  peekMaxLines: 15,
  peekPreviewLines: 10,
  rankingPreset: "foundations-first",
}
