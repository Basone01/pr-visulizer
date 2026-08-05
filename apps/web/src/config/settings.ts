import type { PrecisionPresetName } from "@pr-visulizer/engine"
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

// Per-viewer diff rendering preferences (§10). Controllable core: both default off, the
// reviewer opts in, and the choice persists + applies across every file. Kept small and
// serializable so the KeyValueStore round-trips it as plain JSON.
export type DiffViewSettings = {
  // Wrap long code lines (pre-wrap) instead of scrolling horizontally (pre).
  wrap: boolean

  // Collapse del/add pairs that differ only in whitespace into one context line.
  hideWhitespace: boolean

  // Render the WHOLE head file (changed lines still marked) instead of only the hunks.
  // Needs the head content, so it can't apply to a deleted file — the patch is already
  // that file in full.
  fullFile: boolean

  // Pair the diff into two columns — removed lines on the base (left) side, added lines on the
  // head (right) side — instead of stacking them inline. A pure render-shape choice: it layers
  // over whatever the other three produced, so it composes with all of them.
  splitView: boolean

  // Within a del/add pair, emphasize only the characters that actually differ instead of tinting
  // the whole line. A third layer over the row background and the syntax color (§10) — it changes
  // nothing about the line list, so it composes with every other toggle here.
  intraLineDiff: boolean

  // Render a markdown file's HEAD revision as rich text instead of showing its diff. Unlike the
  // other three this is not a diff transform at all — it REPLACES the diff, and only for a file
  // the app can render (see isMarkdownPath), so on every other file the setting is inert.
  markdownPreview: boolean

  // Inside the markdown preview: render what CHANGED between the two revisions (block by block)
  // instead of the head revision alone. A sub-choice of `markdownPreview` — inert on its own, and
  // inert on a file with no base revision to compare against (an added file). Experimental.
  markdownRichDiff: boolean
}

export const DEFAULT_DIFF_VIEW_SETTINGS: DiffViewSettings = {
  wrap: false,
  hideWhitespace: false,
  fullFile: false,
  splitView: false,
  intraLineDiff: false,
  markdownPreview: false,
  markdownRichDiff: false,
}

// Deep-v2 precision tier preset for the desktop shell (docs/architecture.md §6.2).
// Single source of truth: the Tauri bootstrap resolves the policy from it, and AppShell
// derives the progress steps from it — flip to "off" and both stay consistent.
// Costs ~+3s / +50MB on a 300-file PR for compiler-grade (source:'lsp') edges.
// Kept "off" (user's call) until the precise-phase watchdog + mixed-PR fixes land.
export const DESKTOP_PRECISION_PRESET: PrecisionPresetName = "off"
