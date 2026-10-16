import type { PrCommit, RangeDiff } from "@pr-visulizer/shared"

import type { CommitSelection } from "@/utils/commits/commitSelection"

import type { DiffCommitRangeApi } from "@/hooks/useDiffCommitRange"

// Shared default for DiffPane's commit-range prop, so a test about something else (full-file
// view, split view, the next button) states only what it cares about. This is the "no range
// selected" state — the pane must behave exactly as it did before commit-range selection
// existed, which is precisely what most of those tests are asserting.
export const NO_COMMIT_RANGE: DiffCommitRangeApi = {
  pickerOpen: false,
  openPicker: () => {},
  closePicker: () => {},

  commits: [],
  commitsTruncated: false,
  hasCommits: true,

  selection: null,
  select: () => {},
  selectSha: () => {},
  clear: () => {},
  source: null,
  historyPath: null,

  range: null,
  rangeDiff: null,
  isLoading: false,
  error: null,

  touchedPaths: null,
  fileCount: 0,
  fileInRange: () => null,
}

// Build a commit-range API with a range ACTIVE, for the tests that are about ranging. Anything
// not passed keeps its no-range default, so a test names only the part it drives.
export function activeCommitRange(overrides: {
  commits?: PrCommit[]
  selection?: CommitSelection | null
  rangeDiff: RangeDiff
  clear?: () => void
  select?: (index: number) => void
}): DiffCommitRangeApi {
  const { rangeDiff } = overrides
  const touched = new Set(rangeDiff.files.map((file) => file.path))

  return {
    ...NO_COMMIT_RANGE,
    commits: overrides.commits ?? [],
    selection: overrides.selection ?? null,
    select: overrides.select ?? (() => {}),
    clear: overrides.clear ?? (() => {}),
    source: "picker",
    range: { baseSha: rangeDiff.baseSha, headSha: rangeDiff.headSha },
    rangeDiff,
    touchedPaths: touched,
    fileCount: rangeDiff.files.length,
    fileInRange: (path: string) => rangeDiff.files.find((file) => file.path === path) ?? null,
  }
}
