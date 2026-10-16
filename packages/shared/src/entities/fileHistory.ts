import { z } from "zod"

import { prCommitSchema } from "./commitRange.js"

// File history lens for the DIFF PANE (docs/architecture.md §10): the PR commits that touched
// one file, so a reviewer can step through that file's changes one commit at a time. A history
// step is a single-commit range, so it reuses the commit-range diff, chip and tray marks.
export const fileHistorySchema = z.object({
  path: z.string(),
  // Oldest-first, the canonical PR commit order, only commits that touched `path`.
  // Each entry is a full PrCommit (sha, parents, messageHeadline, author, authoredAt),
  // so a single-commit range is `commitRange(entry, entry, prBaseSha)` with no second lookup.
  commits: z.array(prCommitSchema),
  // True when the PR commit list hit GitHub's 250 cap or the path listing was cut short.
  truncated: z.boolean(),
})
export type FileHistory = z.infer<typeof fileHistorySchema>
