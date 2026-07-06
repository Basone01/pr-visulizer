import type { ReviewProgress } from "@pr-visulizer/shared"

import type { PrTarget } from "@/entity/pr"

import type { AnalysisResponse, PrClient, ReviewSubmission } from "../prClient"
import { pr42Patches } from "./patches"
import { pr42Analysis } from "./pr42"

// Serves the PR #42 fixture client-side so the SPA renders end-to-end without the
// BFF (VITE_FIXTURE=1). Progress lives in memory so optimistic checkmarks round-trip.

const SIMULATED_LATENCY_MS = 120

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), SIMULATED_LATENCY_MS))
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
    getAnalysis(): Promise<AnalysisResponse> {
      return delay({ status: "ready", result: pr42Analysis })
    },

    getPatch(_target: PrTarget, path: string): Promise<string> {
      return delay(pr42Patches[path] ?? "")
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

    deepen(): Promise<void> {
      // The fast fixture has no deep upgrade; the button stays a placeholder (§task).
      return delay(undefined)
    },
  }
}
