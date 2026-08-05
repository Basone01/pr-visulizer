// Unified-diff patches for PR #42 (docs/architecture.md §7), keyed by file path.
// These stand in for the BFF files endpoint (§9) in fixture mode. withRateLimit.ts
// mirrors the app-shell design exactly (16 added lines).

export const pr42Patches: Record<string, string> = {
  "src/config/limits.ts": [
    "@@ -0,0 +1,4 @@",
    "+export type RateLimitConfig = { windowMs: number; max: number }",
    "+",
    "+export const LOGIN_RATE_LIMIT: RateLimitConfig = { windowMs: 60000, max: 5 }",
    "+",
  ].join("\n"),

  // The hunk deliberately starts BELOW the `ApiError` declaration (symbol span 1–5): only the
  // field lines changed, so head lines 1–2 — including the signature — exist in the head file
  // and in NO hunk. That is the shape the peek popover has to survive: a definition wider than
  // its changed region (§10). The full-file view feeds on the same gap.
  "src/types/http.ts": [
    "@@ -3,2 +3,3 @@",
    "-  message: string",
    "+  message: string",
    "+  retryAfterSeconds?: number",
    " }",
  ].join("\n"),

  "src/lib/rateLimiter.ts": [
    "@@ -0,0 +1,18 @@",
    '+import type { RateLimitConfig } from "../config/limits"',
    "+",
    "+export function createRateLimiter(config: RateLimitConfig) {",
    "+  const hits = new Map<string, number[]>()",
    "+",
    "+  function pruneOldHits(key: string, now: number) {",
    "+    const recent = (hits.get(key) ?? []).filter((t) => now - t < config.windowMs)",
    "+    hits.set(key, recent)",
    "+  }",
    "+",
    "+  return {",
    "+    checkLimit(key: string): boolean {",
    "+      const now = Date.now()",
    "+      pruneOldHits(key, now)",
    "+      hits.get(key)!.push(now)",
    "+      return hits.get(key)!.length <= config.max",
    "+    },",
    "+  }",
    "+}",
  ].join("\n"),

  "src/middleware/withRateLimit.ts": [
    "@@ -0,0 +1,16 @@",
    "+import { createRateLimiter } from '../lib/rateLimiter';",
    "+import { LOGIN_RATE_LIMIT } from '../config/limits';",
    "+import type { ApiError } from '../types/http';",
    "+",
    "+const limiter = createRateLimiter(LOGIN_RATE_LIMIT);",
    "+",
    "+export function withRateLimit(handler: Handler): Handler {",
    "+  return async (req, res) => {",
    "+    if (!limiter.checkLimit(req.ip)) {",
    "+      const err: ApiError = { code: 'RATE_LIMITED',",
    "+        message: 'Too many attempts', retryAfterSeconds: 60 };",
    "+      return res.status(429).json(err);",
    "+    }",
    "+    return handler(req, res);",
    "+  };",
    "+}",
  ].join("\n"),

  "src/api/routes/login.ts": [
    "@@ -1,4 +1,8 @@",
    " import { authenticate } from '../../auth'",
    "+import { withRateLimit } from '../../middleware/withRateLimit'",
    " ",
    "-export const loginHandler = async (req, res) => authenticate(req, res)",
    "+export const loginHandler = withRateLimit(async (req, res) => {",
    "+  const user = await authenticate(req, res)",
    "+  if (!user) return res.status(401).end()",
    "+  return res.json({ user })",
    "+})",
  ].join("\n"),

  "src/lib/rateLimiter.test.ts": [
    "@@ -0,0 +1,10 @@",
    '+import { createRateLimiter } from "./rateLimiter"',
    '+import { LOGIN_RATE_LIMIT } from "../config/limits"',
    "+",
    '+test("blocks after the limit", () => {',
    "+  const limiter = createRateLimiter(LOGIN_RATE_LIMIT)",
    "+  for (let i = 0; i < LOGIN_RATE_LIMIT.max; i++) limiter.checkLimit('k')",
    "+",
    "+  const allowed = limiter.checkLimit('k')",
    "+  expect(allowed).toBe(false)",
    "+})",
  ].join("\n"),
}
