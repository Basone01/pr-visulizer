import {
  type CommitRange,
  type DraftComment,
  type FileHistory,
  type PrCommitList,
  type PrOverview,
  type PrSummary,
  type RangeDiff,
  type ReviewComment,
  type ReviewProgress,
  type Viewer,
  mergeViewedFiles,
  viewedDelta,
} from "@pr-visulizer/shared"

import type { AnalysisProgress, AnalysisProgressListener } from "@/entity/analysisProgress"
import type { PrTarget, RepoRef } from "@/entity/pr"

import {
  type AnalysisResponse,
  type PrClient,
  REVISION_PINNED_PR_REVISION_CHANGED_MESSAGE,
  type ReviewSubmission,
  RevisionPinnedPatchError,
  type RevisionPinnedPatchSnapshotRequest,
} from "../prClient"
import {
  BIG_FIXTURE_NUMBER,
  BIG_MARKDOWN_HEAD,
  BIG_MARKDOWN_PATH,
  GHOST_HEAD,
  GHOST_PATH,
  bigPatch,
  buildBigAnalysis,
} from "./bigFixture"
import { pr42Commits, pr42CommitsTouching, pr42RangeDiff } from "./commits"
import { pr42HeadFile } from "./headFiles"
import { pr42Patches } from "./patches"
import { pr42Analysis } from "./pr42"
import { pr42ReviewComments } from "./reviewComments"

// Serves the PR #42 fixture client-side so the SPA renders end-to-end without the
// BFF (VITE_FIXTURE=1). Progress lives in memory so optimistic checkmarks round-trip.

const SIMULATED_LATENCY_MS = 120

// The analysis deliberately lags the overview so the PROGRESSIVE shell is observable in dev:
// the tray + progress panel render at overview speed, then the graph swaps in ~1.5s later,
// with the synthetic step sequence animating across that window (task 4/5).
const SIMULATED_ANALYSIS_MS = 1500

function delay<T>(value: T, ms: number = SIMULATED_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function assertFixtureSnapshotRevision(
  target: PrTarget,
  request: RevisionPinnedPatchSnapshotRequest
): void {
  const revision =
    target.number === BIG_FIXTURE_NUMBER
      ? { baseSha: "base999", headSha: "head999" }
      : pr42Analysis.pr
  if (request.baseSha !== revision.baseSha || request.headSha !== revision.headSha) {
    throw new RevisionPinnedPatchError(
      "revision-changed",
      REVISION_PINNED_PR_REVISION_CHANGED_MESSAGE
    )
  }
}

function emptyProgress(target: PrTarget): ReviewProgress {
  return {
    userId: "fixture-user",
    owner: target.owner,
    repo: target.repo,
    prNumber: target.number,
    headSha: pr42Analysis.pr.headSha,
    reviewedFiles: [],
    drafts: [],
  }
}

// Ids for comments published by a fixture submit. Starts above every id in reviewComments.ts so
// a submitted comment can never collide with a seeded thread's root.
const FIRST_PUBLISHED_COMMENT_ID = 7001

// Swap one comment's body in place, by id. Answers whether it was there, so the caller can fail
// the way GitHub does on an unknown id instead of silently recording an edit that never landed.
function replaceCommentBody(comments: ReviewComment[], commentId: number, body: string): boolean {
  const index = comments.findIndex((comment) => comment.id === commentId)
  if (index < 0) return false

  comments[index] = { ...comments[index]!, body }
  return true
}

function toPublishedComment(draft: DraftComment, index: number): ReviewComment {
  return {
    id: FIRST_PUBLISHED_COMMENT_ID + index,
    path: draft.path,
    line: draft.line,
    startLine: draft.startLine ?? null,
    side: draft.side,
    inReplyToId: null,
    // The same login getViewer() answers with — a submitted comment is the reviewer's own.
    author: "reviewer-dev",
    body: draft.body,
    createdAt: new Date().toISOString(),
  }
}

export function createFixturePrClient(): PrClient {
  // Progress is engine-independent state (§4.2); a single in-memory copy is enough.
  let progress = emptyProgress({
    owner: pr42Analysis.pr.owner,
    repo: pr42Analysis.pr.repo,
    number: pr42Analysis.pr.number,
  })

  // Fixture mode has no GitHub, so it plays BOTH sides of the two-way "Viewed" sync (§11)
  // in memory: `remoteViewed` stands in for github.com's checkboxes and `syncedBase` for the
  // merge's ancestor. It runs the SAME pure merge the BFF and the desktop client run, so the
  // fixture exercises the real reconciliation rather than a shortcut that always agrees.
  let remoteViewed: string[] = []
  let syncedBase: string[] | null = null

  // Comments a fixture submit has "published" — served beside the seeded threads (see below).
  const publishedComments: ReviewComment[] = []

  // This client's OWN copy of the seeded threads. `pr42ReviewComments()` builds a fresh array on
  // every call, so editing what it returns would be forgotten by the next read — an edit has to
  // stick for fixture mode to exercise the feature at all.
  const seededComments = pr42ReviewComments()

  function syncViewed(current: ReviewProgress): ReviewProgress {
    const merged = mergeViewedFiles({
      local: current.reviewedFiles,
      remote: remoteViewed,
      base: syncedBase,
    })

    const { toMark, toUnmark } = viewedDelta(remoteViewed, merged)
    const unmarked = new Set(toUnmark)
    remoteViewed = [...remoteViewed.filter((path) => !unmarked.has(path)), ...toMark]
    syncedBase = merged

    progress = { ...current, reviewedFiles: merged }
    return { ...progress, viewedSync: { status: "synced" } }
  }

  return {
    getOverview(target: PrTarget): Promise<PrOverview> {
      if (target.number === BIG_FIXTURE_NUMBER) {
        const big = buildBigAnalysis(target.owner, target.repo)
        return delay({ pr: big.pr, files: big.files })
      }

      const { pr } = pr42Analysis
      // Serve meta + the changed-file list (analysis.files are already ChangedFile[]).
      return delay({
        pr: { ...pr, owner: target.owner, repo: target.repo },
        files: pr42Analysis.files,
      })
    },

    getAnalysis(target: PrTarget): Promise<AnalysisResponse> {
      if (target.number === BIG_FIXTURE_NUMBER) {
        return delay(
          { status: "ready", result: buildBigAnalysis(target.owner, target.repo) },
          SIMULATED_ANALYSIS_MS
        )
      }

      return delay({ status: "ready", result: pr42Analysis }, SIMULATED_ANALYSIS_MS)
    },

    // Emit a synthetic step sequence so the progressive shell (progress panel + live counter)
    // is exercisable in fixture dev without a real engine (task 5). These are illustrative
    // timings, not measured work — the counters mirror PR #42's 6 changed files, and the
    // sequence is stretched across the analysis window above so it animates on screen.
    subscribeAnalysisProgress(_target: PrTarget, listener: AnalysisProgressListener): () => void {
      const timers: ReturnType<typeof setTimeout>[] = []
      const emit = (progress: AnalysisProgress, at: number): void => {
        timers.push(setTimeout(() => listener(progress), at))
      }

      emit({ step: "fetching-pr" }, 100)
      emit({ step: "reading-files", done: 3, total: 6 }, 450)
      emit({ step: "reading-files", done: 6, total: 6 }, 750)
      emit({ step: "parsing", done: 6, total: 6 }, 1050)
      emit({ step: "resolving" }, 1250)
      emit({ step: "ranking" }, 1400)

      return () => timers.forEach(clearTimeout)
    },

    listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]> {
      // The fixture repo is the PR #42 one (acme/web); every other repo lists nothing.
      const { pr } = pr42Analysis
      if (repo.owner !== pr.owner || repo.repo !== pr.repo) return delay([])

      // More than the home card lists at once, on purpose: the card shows the few most recent
      // and a search reaches the rest (§5), so the fixture has to be able to hide one.
      const summaries: PrSummary[] = [
        {
          number: BIG_FIXTURE_NUMBER,
          title: "Synthetic 120-file PR (profiling)",
          author: "octocat",
          updatedAt: "2026-07-05T09:00:00.000Z",
        },
        {
          number: 51,
          title: "Docs: rate limit runbook",
          author: "reviewer-two",
          updatedAt: "2026-07-04T16:20:00.000Z",
        },
        {
          number: 47,
          title: "Retry on 429 with backoff",
          author: "contributor-dev",
          updatedAt: "2026-07-03T11:05:00.000Z",
        },
        {
          number: 46,
          title: "Drop the unused auth helper",
          author: "senior-dev",
          updatedAt: "2026-07-02T08:45:00.000Z",
        },
        {
          number: pr.number,
          title: pr.title,
          author: "octocat",
          updatedAt: "2026-07-01T12:00:00.000Z",
        },
        {
          number: 31,
          title: "Bump octokit to 22",
          author: "contributor-dev",
          updatedAt: "2026-06-20T10:00:00.000Z",
        },
        // Oldest, and the only other PR whose title says "login" — the one a search has to
        // reach past the recent-PR cap to find.
        {
          number: 28,
          title: "Fix the flaky login test",
          author: "reviewer-two",
          updatedAt: "2026-06-18T14:30:00.000Z",
        },
      ]

      return delay(summaries)
    },

    // Nothing to drop: the fixture serves static data and holds no per-PR cache. Refreshing in
    // fixture mode still refetches every query — it just lands on the same answer.
    invalidatePr(): Promise<void> {
      return Promise.resolve()
    },

    getPatch(target: PrTarget, path: string): Promise<string> {
      if (target.number === BIG_FIXTURE_NUMBER) return delay(bigPatch(path))

      return delay(pr42Patches[path] ?? "")
    },

    async getRevisionPinnedPatchSnapshot(target, request) {
      assertFixtureSnapshotRevision(target, request)
      const patches = Object.fromEntries(
        await Promise.all(
          [...new Set(request.paths)].map(async (path) => [path, await this.getPatch(target, path)])
        )
      )
      assertFixtureSnapshotRevision(target, request)
      return { baseSha: request.baseSha, headSha: request.headSha, patches }
    },

    // §10 commit-range picker. The big fixture has no commit history behind it, so it offers no
    // range — the picker hides itself rather than showing an empty list.
    listCommits(target: PrTarget): Promise<PrCommitList> {
      if (target.number === BIG_FIXTURE_NUMBER) return delay({ commits: [], truncated: false })

      return delay({ commits: pr42Commits(), truncated: false })
    },

    getRangeDiff(target: PrTarget, range: CommitRange): Promise<RangeDiff> {
      if (target.number === BIG_FIXTURE_NUMBER) {
        return delay({ ...range, files: [], truncated: false })
      }

      return delay(pr42RangeDiff(range.baseSha, range.headSha))
    },

    // The big fixture has no commit history, so every file has an empty history there.
    getFileHistory(target: PrTarget, path: string): Promise<FileHistory> {
      if (target.number === BIG_FIXTURE_NUMBER)
        return delay({ path, commits: [], truncated: false })

      return delay({ path, commits: pr42CommitsTouching(path), truncated: false })
    },

    // The big fixture is synthetic patches with no head file behind them — it answers "no head
    // content", which is exactly the unavailable path the toolbar has to handle.
    addCommentNow(): Promise<void> {
      // Recorded nowhere visible — fixture mode has no GitHub; the composer's success path
      // is what's being exercised.
      return delay(undefined)
    },

    listReviewComments(target: PrTarget): Promise<ReviewComment[]> {
      // Only the PR #42 fixture carries threads; the big profiling PR has none.
      if (target.number === BIG_FIXTURE_NUMBER) return delay([])

      return delay([...seededComments, ...publishedComments])
    },

    // Edit either kind of comment — a seeded thread or one this session submitted. Same
    // "unknown id fails" rule the fake gateway follows, so the failure path stays reachable.
    updateReviewComment(_target: PrTarget, commentId: number, body: string): Promise<void> {
      const edited =
        replaceCommentBody(seededComments, commentId, body) ||
        replaceCommentBody(publishedComments, commentId, body)

      if (!edited) return Promise.reject(new Error(`No review comment ${commentId}`))

      return delay(undefined)
    },

    getFileAtHead(target: PrTarget, path: string): Promise<string | null> {
      // The big fixture serves head text for exactly two paths — its ghost, and the one markdown
      // file the preview needs. Every other path stays null, so the "content unavailable" state
      // the toolbar has to handle remains reachable in fixture mode.
      if (target.number === BIG_FIXTURE_NUMBER) {
        if (path === GHOST_PATH) return delay(GHOST_HEAD)
        if (path === BIG_MARKDOWN_PATH) return delay(BIG_MARKDOWN_HEAD)

        return delay(null)
      }

      return delay(pr42HeadFile(path))
    },

    getProgress(): Promise<ReviewProgress> {
      return delay(syncViewed(progress))
    },

    putProgress(_target: PrTarget, next: ReviewProgress): Promise<ReviewProgress> {
      progress = next
      return delay(syncViewed(progress))
    },

    submitReview(target: PrTarget, submission: ReviewSubmission): Promise<void> {
      progress = { ...progress, verdict: submission.verdict }

      // Play GitHub's half of the submit: the drafted comments are published, so the next read
      // of the comment list must carry them. Without this, fixture mode could never show the
      // just-submitted comments appearing in the diff — the very thing the refetch exists for.
      if (target.number !== BIG_FIXTURE_NUMBER) {
        // Index off the running list, not off this submission, so ids stay unique across submits.
        for (const draft of submission.comments) {
          publishedComments.push(toPublishedComment(draft, publishedComments.length))
        }
      }

      return delay(undefined)
    },

    getViewer(): Promise<Viewer> {
      // A dev reviewer whose login differs from PR #42's author ("octocat"), so Approve
      // stays ENABLED in fixture dev; the disabled own-PR path is covered by render tests.
      const viewer: Viewer = {
        userId: "fixture-viewer-1",
        login: "reviewer-dev",
        name: "Fixture Reviewer",
        avatarUrl: null,
      }
      return delay(viewer)
    },
  }
}
