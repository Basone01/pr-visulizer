import type { PrOverview, PrSummary, ReviewProgress, Viewer } from "@pr-visulizer/shared"

import type { AnalysisProgress, AnalysisProgressListener } from "@/entity/analysisProgress"
import type { PrTarget, RepoRef } from "@/entity/pr"

import type { AnalysisResponse, PrClient, ReviewSubmission } from "../prClient"
import { BIG_FIXTURE_NUMBER, GHOST_HEAD, GHOST_PATH, bigPatch, buildBigAnalysis } from "./bigFixture"
import { pr42HeadFile } from "./headFiles"
import { pr42Patches } from "./patches"
import { pr42Analysis } from "./pr42"

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

export function createFixturePrClient(): PrClient {
  // Progress is engine-independent state (§4.2); a single in-memory copy is enough.
  let progress = emptyProgress({
    owner: pr42Analysis.pr.owner,
    repo: pr42Analysis.pr.repo,
    number: pr42Analysis.pr.number,
  })

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

      const summary: PrSummary = {
        number: pr.number,
        title: pr.title,
        author: "octocat",
        updatedAt: "2026-07-01T12:00:00.000Z",
      }
      return delay([summary])
    },

    getPatch(target: PrTarget, path: string): Promise<string> {
      if (target.number === BIG_FIXTURE_NUMBER) return delay(bigPatch(path))

      return delay(pr42Patches[path] ?? "")
    },

    // The big fixture is synthetic patches with no head file behind them — it answers "no head
    // content", which is exactly the unavailable path the toolbar has to handle.
    addCommentNow(): Promise<void> {
      // Recorded nowhere visible — fixture mode has no GitHub; the composer's success path
      // is what's being exercised.
      return delay(undefined)
    },

    getFileAtHead(target: PrTarget, path: string): Promise<string | null> {
      // The big fixture serves only its ghost's head text — every other path stays null so
      // the "content unavailable" state remains reachable in fixture mode.
      if (target.number === BIG_FIXTURE_NUMBER)
        return delay(path === GHOST_PATH ? GHOST_HEAD : null)

      return delay(pr42HeadFile(path))
    },

    getProgress(): Promise<ReviewProgress> {
      return delay(progress)
    },

    putProgress(_target: PrTarget, next: ReviewProgress): Promise<ReviewProgress> {
      progress = next
      return delay(progress)
    },

    submitReview(_target: PrTarget, submission: ReviewSubmission): Promise<void> {
      progress = { ...progress, verdict: submission.verdict }
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
