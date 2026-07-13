import type { AnalysisEngine, PrTarget } from "@pr-visulizer/engine"
import type { AnalysisResult } from "@pr-visulizer/shared"

import type { AnalysisJobState } from "../../entities/index.js"

// The 202-then-poll orchestrator (docs/architecture.md §9). The first request for a
// PR starts the in-process pipeline and returns `analyzing`; polls return `analyzing`
// until the job resolves, then `ready` with the result. No WebSocket infra — the
// analysis of a typical PR is a few seconds. The engine owns its own result cache (§5).

export type AnalysisService = {
  request(target: PrTarget): AnalysisJobState
}

// A running or finished job — replaced (never mutated) on completion.
type Job = { done: false } | { done: true; result: AnalysisResult } | { done: true; error: unknown }

export function createAnalysisService(engine: AnalysisEngine): AnalysisService {
  const jobs = new Map<string, Job>()

  const jobKey = (target: PrTarget): string =>
    `${engine.name}:${target.owner}/${target.repo}#${target.number}`

  function request(target: PrTarget): AnalysisJobState {
    const key = jobKey(target)
    const existing = jobs.get(key)

    if (existing?.done === true) {
      if ("error" in existing) {
        // Drop the failed job so the next poll retries instead of wedging forever.
        jobs.delete(key)
        throw existing.error
      }

      return { status: "ready", result: existing.result }
    }

    if (existing) return { status: "analyzing" }

    jobs.set(key, { done: false })
    engine
      .analyze(target)
      .then((result) => jobs.set(key, { done: true, result }))
      .catch((error: unknown) => jobs.set(key, { done: true, error }))

    return { status: "analyzing" }
  }

  return { request }
}
