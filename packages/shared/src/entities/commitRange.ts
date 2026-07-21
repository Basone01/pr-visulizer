import { z } from "zod"

// Commit-range selection for the DIFF PANE (docs/architecture.md §10). A reviewer picks one
// commit — or a contiguous run of them — and the open file's diff is restricted to that range
// instead of base..head. Ranking, the graph and the review queue stay whole-PR: review ORDER
// is a whole-PR concept, and GitHub's "Viewed" checkboxes are whole-PR state.

// One commit of the PR, as the picker lists it.
export const prCommitSchema = z.object({
  sha: z.string(),
  // The commit's parent SHAs. `parents[0]` is the FIRST parent — the mainline one — and it is
  // how a range's base is derived (see `commitRange` below). Verified 2026-07 against
  // docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request: `parents` is a
  // required array whose entries carry a required `sha`.
  parents: z.array(z.string()),
  // The first line of the commit message — everything the picker shows.
  messageHeadline: z.string(),
  author: z.string(),
  authoredAt: z.string(),
})
export type PrCommit = z.infer<typeof prCommitSchema>

export const prCommitListSchema = z.object({
  commits: z.array(prCommitSchema),
  // GitHub "Lists a maximum of 250 commits for a pull request" (verified 2026-07, source
  // above). Past that the list is silently short, so say so rather than let a reviewer
  // believe they are choosing from the whole PR.
  truncated: z.boolean(),
})
export type PrCommitList = z.infer<typeof prCommitListSchema>

// The two ends of a compare. `base` is an EXCLUSIVE boundary (the parent of the first selected
// commit), `head` is the last selected commit — so the diff covers base..head inclusive of head.
export const commitRangeSchema = z.object({
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
})
export type CommitRange = z.infer<typeof commitRangeSchema>

// One file as the compare endpoint reports it. Same shape as a changed file plus the patch and
// the pre-rename path, which only the compare payload carries.
export const rangeDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  // null when GitHub omits a diff — binary, too large, or a pure rename with no content change.
  patch: z.string().nullable(),
  // Set only for a renamed file: the path it had BEFORE this range. A file renamed inside the
  // range appears under its new path here but under a different one in the whole-PR file list,
  // which is why the lookup has to consider both (see `rangeFileFor`).
  previousPath: z.string().nullable(),
})
export type RangeDiffFile = z.infer<typeof rangeDiffFileSchema>

export const rangeDiffSchema = z.object({
  baseSha: z.string(),
  headSha: z.string(),
  files: z.array(rangeDiffFileSchema),
  // The compare response "includes up to 300 changed files for the entire comparison" and only
  // on the first page (verified 2026-07,
  // docs.github.com/en/rest/commits/commits#compare-two-commits). Beyond that the file list is
  // incomplete, and a file missing from it is NOT proof the range left it untouched.
  truncated: z.boolean(),
})
export type RangeDiff = z.infer<typeof rangeDiffSchema>

// How many characters of a SHA the UI shows. GitHub's own short form.
const SHORT_SHA_LENGTH = 7

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH)
}

// Derive the compare range for a contiguous run of commits, `first` through `last` inclusive.
//
// The base is the FIRST PARENT of the first selected commit, never `${sha}^`: the compare
// endpoint documents its basehead as refs and says nothing about git rev syntax, and `^` is
// unsafe in a URL path. `parents[0]` is a documented field of the commits payload, so the
// boundary is data we already hold rather than a syntax we would be guessing at.
//
// `fallbackBaseSha` (the PR's own base) covers a first selected commit with NO parents — a root
// commit, which a fresh repository's first PR really can contain.
export function commitRange(first: PrCommit, last: PrCommit, fallbackBaseSha: string): CommitRange {
  return {
    baseSha: first.parents[0] ?? fallbackBaseSha,
    headSha: last.sha,
  }
}

// Look up one path in a range diff. A file renamed INSIDE the range is listed under its new
// path, so a lookup by the whole-PR path also has to check `previousPath` — otherwise renaming
// a file mid-PR makes it look untouched by the very range that renamed it.
export function rangeFileFor(diff: RangeDiff, path: string): RangeDiffFile | null {
  return diff.files.find((file) => file.path === path || file.previousPath === path) ?? null
}

// Every path a range touches, under BOTH its current and pre-rename name, so the tray can mark
// untouched rows regardless of which name it holds.
export function rangeTouchedPaths(diff: RangeDiff): Set<string> {
  const paths = new Set<string>()

  for (const file of diff.files) {
    paths.add(file.path)
    if (file.previousPath) paths.add(file.previousPath)
  }

  return paths
}
