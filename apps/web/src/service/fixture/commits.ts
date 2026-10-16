import type { PrCommit, RangeDiff, RangeDiffFile } from "@pr-visulizer/shared"

import { pr42Patches } from "./patches"
import { pr42Analysis } from "./pr42"

// The commits PR #42 was built from, for the diff pane's commit-range picker in fixture mode
// (§10). They partition the six changed files in dependency order — config, then the limiter,
// then the wiring — so selecting one commit restricts the diff to a genuinely different slice
// and selecting two unions them. Mirrors the engine's PR #42 commit fixture, so fixture mode
// and fake-gateway mode tell the reviewer the same story.

const paths = {
  limits: "src/config/limits.ts",
  http: "src/types/http.ts",
  rateLimiter: "src/lib/rateLimiter.ts",
  withRateLimit: "src/middleware/withRateLimit.ts",
  login: "src/api/routes/login.ts",
  test: "src/lib/rateLimiter.test.ts",
} as const

export const PR42_COMMIT_SHAS = {
  config: "c0ffee1000000000000000000000000000000001",
  limiter: "c0ffee2000000000000000000000000000000002",
  wiring: "c0ffee3000000000000000000000000000000003",
} as const

// One commit plus the files it contributed. The per-commit slices are the fixture's machinery
// for DERIVING a compare — a range diff is assembled from them the way the real one is, rather
// than hard-coded per range.
type FixtureCommit = PrCommit & { paths: string[] }

const FIXTURE_COMMITS: FixtureCommit[] = [
  {
    sha: PR42_COMMIT_SHAS.config,
    // The first commit's parent IS the PR base, so selecting it alone compares base...c1.
    parents: [pr42Analysis.pr.baseSha],
    messageHeadline: "Add rate-limit config and the retryAfter field",
    author: "contributor-dev",
    authoredAt: "2026-06-28T09:14:00Z",
    paths: [paths.limits, paths.http],
  },
  {
    sha: PR42_COMMIT_SHAS.limiter,
    parents: [PR42_COMMIT_SHAS.config],
    messageHeadline: "Add the rate limiter and its unit tests",
    author: "contributor-dev",
    authoredAt: "2026-06-29T15:02:00Z",
    paths: [paths.rateLimiter, paths.test],
  },
  {
    sha: PR42_COMMIT_SHAS.wiring,
    parents: [PR42_COMMIT_SHAS.limiter],
    messageHeadline: "Wire the middleware into the login route",
    author: "contributor-dev",
    authoredAt: "2026-06-30T11:47:00Z",
    paths: [paths.withRateLimit, paths.login],
  },
]

// The picker's view of the commits — the contract shape, without the fixture's file slices.
export function pr42Commits(): PrCommit[] {
  return FIXTURE_COMMITS.map(({ paths: _paths, ...commit }) => commit)
}

// The file history lens's view (§10): the commits whose slice includes `path`, in PR order.
export function pr42CommitsTouching(path: string): PrCommit[] {
  return FIXTURE_COMMITS.filter((commit) => commit.paths.includes(path)).map(
    ({ paths: _paths, ...commit }) => commit
  )
}

function rangeFileFor(path: string): RangeDiffFile {
  const file = pr42Analysis.files.find((candidate) => candidate.path === path)
  if (!file) throw new Error(`PR #42 fixture has no changed file at ${path}`)

  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: pr42Patches[path] ?? null,
    previousPath: null,
  }
}

// Assemble the compare for `baseSha...headSha`. The base is EXCLUSIVE — it is the parent of the
// range's first commit — so the run starts at the commit whose first parent IS the base.
export function pr42RangeDiff(baseSha: string, headSha: string): RangeDiff {
  const startIndex = FIXTURE_COMMITS.findIndex((commit) => commit.parents[0] === baseSha)
  const endIndex = FIXTURE_COMMITS.findIndex((commit) => commit.sha === headSha)

  // An unknown boundary would silently produce a wrong slice; an empty range is the honest
  // answer, and the diff pane renders it as "no changes in the selected commits".
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return { baseSha, headSha, files: [], truncated: false }
  }

  const selected = FIXTURE_COMMITS.slice(startIndex, endIndex + 1)
  const touched = new Set(selected.flatMap((commit) => commit.paths))

  return {
    baseSha,
    headSha,
    files: [...touched].map(rangeFileFor),
    truncated: false,
  }
}
