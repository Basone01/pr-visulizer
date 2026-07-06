import type { PrMeta } from "@pr-visulizer/shared"

import type { GatewayChangedFile } from "../gateway.js"

// PR #42 — "Add login rate limiting" (docs/architecture.md §7), the worked example
// every §7–§8 number is asserted against. These are REAL TypeScript sources: parsing
// them with tree-sitter must reproduce the §7 edge set (and therefore the §8.1
// ranking) end-to-end. The imports/calls/types below are the executable fixture.

export const PR42_PATHS = {
  limits: "src/config/limits.ts",
  http: "src/types/http.ts",
  rateLimiter: "src/lib/rateLimiter.ts",
  withRateLimit: "src/middleware/withRateLimit.ts",
  login: "src/api/routes/login.ts",
  test: "src/lib/rateLimiter.test.ts",
} as const

export const PR42_META: PrMeta = {
  owner: "acme",
  repo: "web",
  number: 42,
  title: "Add login rate limiting",
  baseSha: "base0042cafebabe",
  headSha: "head0042deadbeef",
}

// 1 — src/config/limits.ts (added). Foundational config: no changed-file imports.
const limitsSource = `// src/config/limits.ts — rate-limit configuration (added in PR #42).

export type RateLimitConfig = {
  windowMs: number
  max: number
}

export const LOGIN_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  max: 5,
}
`

// 2 — src/types/http.ts (modified). ApiError gains the optional retryAfterSeconds
// field; the patch's head hunk intersects the ApiError span → changeKind "modified".
const httpSource = `// src/types/http.ts — shared HTTP types.

export type ApiError = {
  code: number
  message: string
  retryAfterSeconds?: number
}
`
const httpPatch = `@@ -3,4 +3,5 @@
 export type ApiError = {
   code: number
   message: string
+  retryAfterSeconds?: number
 }
`

// 3 — src/lib/rateLimiter.ts (added). uses-type RateLimitConfig (→ limits).
const rateLimiterSource = `// src/lib/rateLimiter.ts — request rate limiter (added in PR #42).
import type { RateLimitConfig } from "../config/limits.js"

export function createRateLimiter(config: RateLimitConfig) {
  let hits = 0

  return {
    remaining: (): number => config.max - hits,
    record: (): void => {
      hits += 1
    },
  }
}

export function checkLimit(config: RateLimitConfig, attempts: number): boolean {
  return attempts <= config.max
}
`

// 4 — src/middleware/withRateLimit.ts (added). imports rateLimiter, http, limits;
// calls createRateLimiter + checkLimit; uses-type ApiError.
const withRateLimitSource = `// src/middleware/withRateLimit.ts — login rate-limit middleware (added in PR #42).
import { LOGIN_RATE_LIMIT } from "../config/limits.js"
import { checkLimit, createRateLimiter } from "../lib/rateLimiter.js"
import type { ApiError } from "../types/http.js"

export function withRateLimit(handler: () => ApiError | null): () => ApiError | null {
  const limiter = createRateLimiter(LOGIN_RATE_LIMIT)

  return (): ApiError | null => {
    if (!checkLimit(LOGIN_RATE_LIMIT, limiter.remaining())) {
      const error: ApiError = {
        code: 429,
        message: "Too Many Requests",
        retryAfterSeconds: LOGIN_RATE_LIMIT.windowMs / 1000,
      }
      return error
    }

    return handler()
  }
}
`

// 5 — src/api/routes/login.ts (modified). loginHandler now wraps itself in the new
// middleware; the patch's head hunk intersects loginHandler → "modified".
const loginSource = `// src/api/routes/login.ts — login route (modified in PR #42).
import { withRateLimit } from "../../middleware/withRateLimit.js"

export function loginHandler() {
  const guarded = withRateLimit(() => null)
  return guarded()
}
`
const loginPatch = `@@ -1,4 +1,6 @@
-// src/api/routes/login.ts — login route.
+// src/api/routes/login.ts — login route (modified in PR #42).
+import { withRateLimit } from "../../middleware/withRateLimit.js"

 export function loginHandler() {
-  return null
+  const guarded = withRateLimit(() => null)
+  return guarded()
 }
`

// 6 — src/lib/rateLimiter.test.ts (added). imports rateLimiter + limits (→ ranks
// one topo level ABOVE its subject, §8.1, with zero special-casing).
const testSource = `// src/lib/rateLimiter.test.ts — unit tests (added in PR #42).
import { describe, expect, it } from "vitest"

import { LOGIN_RATE_LIMIT } from "../config/limits.js"
import { createRateLimiter } from "./rateLimiter.js"

describe("createRateLimiter", () => {
  it("starts with the full budget", () => {
    const limiter = createRateLimiter(LOGIN_RATE_LIMIT)
    expect(limiter.remaining()).toBe(LOGIN_RATE_LIMIT.max)
  })
})
`

// Head-version content served by the gateway (§5 step 3), keyed by repo path.
export const PR42_CONTENTS: Record<string, string> = {
  [PR42_PATHS.limits]: limitsSource,
  [PR42_PATHS.http]: httpSource,
  [PR42_PATHS.rateLimiter]: rateLimiterSource,
  [PR42_PATHS.withRateLimit]: withRateLimitSource,
  [PR42_PATHS.login]: loginSource,
  [PR42_PATHS.test]: testSource,
}

// Full all-addition patch generated from the head content, so the diff renderer
// has real lines to show (GitHub sends full patches for added files too).
function addedFilePatch(source: string): string {
  const lines = source.replace(/\n$/, "").split("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`
}

// The changed-file list with §7 churn. Modified files carry hand-written patches whose
// hunks drive hunk→symbol mapping (§5 step 5); added files get generated full patches.
export const PR42_FILES: GatewayChangedFile[] = [
  {
    path: PR42_PATHS.limits,
    status: "added",
    additions: 4,
    deletions: 0,
    language: "typescript",
    patch: addedFilePatch(limitsSource),
  },
  {
    path: PR42_PATHS.http,
    status: "modified",
    additions: 2,
    deletions: 1,
    language: "typescript",
    patch: httpPatch,
  },
  {
    path: PR42_PATHS.rateLimiter,
    status: "added",
    additions: 48,
    deletions: 0,
    language: "typescript",
    patch: addedFilePatch(rateLimiterSource),
  },
  {
    path: PR42_PATHS.withRateLimit,
    status: "added",
    additions: 26,
    deletions: 0,
    language: "typescript",
    patch: addedFilePatch(withRateLimitSource),
  },
  {
    path: PR42_PATHS.login,
    status: "modified",
    additions: 6,
    deletions: 2,
    language: "typescript",
    patch: loginPatch,
  },
  {
    path: PR42_PATHS.test,
    status: "added",
    additions: 52,
    deletions: 0,
    language: "typescript",
    patch: addedFilePatch(testSource),
  },
]
