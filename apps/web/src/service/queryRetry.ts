import { ZodError } from "zod"

import { isNeedsRepoSourceError } from "@/entity/repoSource"

import { NoPatchAvailableError, isPatchByteLimitRefusal } from "./prClient"

// The one place that decides which failures react-query retries. A deterministic failure gives
// the same answer for the same input, so retrying only repeats its cost: a 4-run analysis on a
// PR with huge generated files moved 116 MB into the webview before the fix.
const MAX_RETRIES = 3

// Deterministic: no repo source yet (a prompt, not a fault), a patch refused on bytes, no diff
// for the file, or data that failed its schema. Anything else (network, GitHub 5xx, a git
// child that died) may pass on the next try.
export function isDeterministicFailure(error: unknown): boolean {
  return (
    isNeedsRepoSourceError(error) ||
    isPatchByteLimitRefusal(error) ||
    error instanceof NoPatchAvailableError ||
    error instanceof ZodError
  )
}

// Typed as react-query's default Error so a query using it keeps `error: Error`.
export function shouldRetryQuery(failureCount: number, error: Error): boolean {
  return failureCount < MAX_RETRIES && !isDeterministicFailure(error)
}
