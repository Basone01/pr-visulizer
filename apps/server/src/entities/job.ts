import type { AnalysisResult } from "@pr-visulizer/shared"

// Server-only analysis job state (docs/architecture.md §9 "202-then-poll").
// The route returns `analyzing` while the fast pipeline runs in-process, then the
// `AnalysisResult` once ready — the SPA polls until it flips.

export type AnalysisJobState = { status: "analyzing" } | { status: "ready"; result: AnalysisResult }

// Discriminated so an unfinished job can never expose a half-built result.
export type AnalysisJob =
  | { done: false; promise: Promise<AnalysisResult> }
  | { done: true; result: AnalysisResult }
  | { done: true; error: unknown }
