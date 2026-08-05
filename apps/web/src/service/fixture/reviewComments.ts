import type { ReviewComment } from "@pr-visulizer/shared"

// Existing published review comments for the PR #42 fixture (VITE_FIXTURE), so the "show existing
// comments" feature is reachable in the browser with no BFF. Deliberately four shapes:
//   - a two-comment THREAD (root 6001 + reply 6002) on rateLimiter.ts head line 3 → anchors inline
//   - a single comment on head line 12 → a one-comment thread (no count badge)
//   - a multi-line RANGE comment (start_line 6 → line 9) → anchors at its START line, 6
//   - an OUTDATED comment (line: null) → the file's "not shown inline" bucket
//   - a LEFT-side comment on http.ts → also the bucket (base side is not annotated inline)
// The bodies are GitHub-flavored markdown on purpose — they render through MarkdownContent, which
// is why this feature is the TS agent's: the same sanitization guarantees apply.

const RATE_LIMITER = "src/lib/rateLimiter.ts"
const HTTP = "src/types/http.ts"
const LOGIN = "src/api/routes/login.ts"

export function pr42ReviewComments(): ReviewComment[] {
  return [
    {
      id: 6001,
      path: RATE_LIMITER,
      line: 3,
      startLine: null,
      side: "RIGHT",
      inReplyToId: null,
      author: "senior-dev",
      body: "Should `createRateLimiter` guard against a **zero** `windowMs`?\n\nA `0` window makes `pruneOldHits` drop every hit immediately.",
      createdAt: "2026-07-20T09:12:00Z",
    },
    {
      id: 6002,
      path: RATE_LIMITER,
      line: 3,
      startLine: null,
      side: "RIGHT",
      inReplyToId: 6001,
      author: "contributor-dev",
      body: "Good catch — I'll clamp with `Math.max(1, windowMs)` in a follow-up.\n\nSee the [rate-limiting notes](https://example.com/notes).",
      createdAt: "2026-07-20T10:03:00Z",
    },
    {
      id: 6003,
      path: RATE_LIMITER,
      line: 12,
      startLine: null,
      side: "RIGHT",
      inReplyToId: null,
      author: "reviewer-two",
      body: "`checkLimit` mutates on read — worth a `// side effect` note.",
      createdAt: "2026-07-20T11:20:00Z",
    },
    {
      id: 6006,
      path: RATE_LIMITER,
      // A RANGE comment over the whole `pruneOldHits` helper: GitHub reports the range as
      // start_line 6 through line 9, where `line` is its LAST line. The marker belongs on 6.
      line: 9,
      startLine: 6,
      side: "RIGHT",
      inReplyToId: null,
      author: "reviewer-two",
      body: "This helper rebuilds the whole array on every hit.\n\nFine at these limits, worth a note if the window grows.",
      createdAt: "2026-07-20T12:05:00Z",
    },
    {
      id: 6004,
      path: LOGIN,
      // Outdated: this comment's line was force-pushed away, so GitHub returns a null line.
      line: null,
      startLine: null,
      side: "RIGHT",
      inReplyToId: null,
      author: "senior-dev",
      body: "This handler moved since I commented — keeping the note for history.",
      createdAt: "2026-07-19T16:40:00Z",
    },
    {
      id: 6005,
      path: HTTP,
      line: 4,
      startLine: null,
      // LEFT/base side — not anchored inline; lands in the file bucket.
      side: "LEFT",
      inReplyToId: null,
      author: "reviewer-two",
      body: "Was the old `message` field intentionally kept alongside the new one?",
      createdAt: "2026-07-19T14:20:00Z",
    },
  ]
}
