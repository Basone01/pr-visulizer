import {
  type AnalysisResult,
  type ChangedFile,
  type ChangedSymbol,
  type Edge,
  type RankingInput,
  type SymbolOccurrence,
  analysisResultSchema,
  rankFiles,
  resolveRankingPolicy,
} from "@pr-visulizer/shared"

// PR #42 — "Add login rate limiting" (docs/architecture.md §7), the worked example
// every §7–§8 number traces. Used by fixture mode so the SPA renders end-to-end
// without the BFF. Ranking is computed by the shared core, never hand-written.

const paths = {
  limits: "src/config/limits.ts",
  http: "src/types/http.ts",
  rateLimiter: "src/lib/rateLimiter.ts",
  withRateLimit: "src/middleware/withRateLimit.ts",
  login: "src/api/routes/login.ts",
  test: "src/lib/rateLimiter.test.ts",
} as const

const files: ChangedFile[] = [
  { path: paths.limits, status: "added", additions: 4, deletions: 0, language: "typescript" },
  { path: paths.http, status: "modified", additions: 2, deletions: 1, language: "typescript" },
  { path: paths.rateLimiter, status: "added", additions: 48, deletions: 0, language: "typescript" },
  {
    path: paths.withRateLimit,
    status: "added",
    additions: 26,
    deletions: 0,
    language: "typescript",
  },
  { path: paths.login, status: "modified", additions: 6, deletions: 2, language: "typescript" },
  { path: paths.test, status: "added", additions: 52, deletions: 0, language: "typescript" },
]

const symbolId = (path: string, name: string) => `${path}#${name}`

const symbols: ChangedSymbol[] = [
  {
    id: symbolId(paths.limits, "RateLimitConfig"),
    path: paths.limits,
    name: "RateLimitConfig",
    kind: "type",
    span: { startLine: 1, endLine: 1 },
    changeKind: "added",
  },
  {
    id: symbolId(paths.limits, "LOGIN_RATE_LIMIT"),
    path: paths.limits,
    name: "LOGIN_RATE_LIMIT",
    kind: "const",
    span: { startLine: 3, endLine: 3 },
    changeKind: "added",
  },
  {
    id: symbolId(paths.http, "ApiError"),
    path: paths.http,
    name: "ApiError",
    kind: "type",
    span: { startLine: 1, endLine: 5 },
    changeKind: "modified",
  },
  {
    id: symbolId(paths.rateLimiter, "createRateLimiter"),
    path: paths.rateLimiter,
    name: "createRateLimiter",
    kind: "function",
    // 17 lines (> peekMaxLines 15) — exercises the truncated peek in the design.
    span: { startLine: 3, endLine: 19 },
    changeKind: "added",
  },
  {
    id: symbolId(paths.rateLimiter, "checkLimit"),
    path: paths.rateLimiter,
    name: "checkLimit",
    kind: "method",
    span: { startLine: 12, endLine: 17 },
    changeKind: "added",
  },
  {
    id: symbolId(paths.withRateLimit, "withRateLimit"),
    path: paths.withRateLimit,
    name: "withRateLimit",
    kind: "function",
    span: { startLine: 7, endLine: 16 },
    changeKind: "added",
  },
  {
    id: symbolId(paths.login, "loginHandler"),
    path: paths.login,
    name: "loginHandler",
    kind: "const",
    span: { startLine: 4, endLine: 8 },
    changeKind: "modified",
  },
]

// File-level dependency edges (§7): `from` depends on `to`.
const fileEdges: Array<[string, string]> = [
  [paths.rateLimiter, paths.limits],
  [paths.withRateLimit, paths.rateLimiter],
  [paths.withRateLimit, paths.http],
  [paths.withRateLimit, paths.limits],
  [paths.login, paths.withRateLimit],
  [paths.test, paths.rateLimiter],
  [paths.test, paths.limits],
]

const edges: Edge[] = [
  ...fileEdges.map(([from, to]): Edge => ({
    from,
    to,
    kind: "imports",
    level: "file",
    source: "ast",
  })),
  // A couple of symbol-level edges for the graph legend; they never affect ranking.
  {
    from: symbolId(paths.withRateLimit, "withRateLimit"),
    to: symbolId(paths.rateLimiter, "createRateLimiter"),
    kind: "calls",
    level: "symbol",
    source: "ast",
  },
  {
    from: symbolId(paths.rateLimiter, "createRateLimiter"),
    to: symbolId(paths.limits, "RateLimitConfig"),
    kind: "uses-type",
    level: "symbol",
    source: "ast",
  },
]

// Occurrences drive def <-> usage navigation (§10). Lines are head-version and
// match the patch line numbers in patches.ts exactly.
const definition = (id: string, path: string, line: number): SymbolOccurrence => ({
  symbolId: id,
  path,
  line,
  role: "definition",
})

const usage = (id: string, path: string, line: number): SymbolOccurrence => ({
  symbolId: id,
  path,
  line,
  role: "usage",
})

const RATE_LIMIT_CONFIG = symbolId(paths.limits, "RateLimitConfig")
const LOGIN_RATE_LIMIT = symbolId(paths.limits, "LOGIN_RATE_LIMIT")
const API_ERROR = symbolId(paths.http, "ApiError")
const CREATE_RATE_LIMITER = symbolId(paths.rateLimiter, "createRateLimiter")
const CHECK_LIMIT = symbolId(paths.rateLimiter, "checkLimit")
const WITH_RATE_LIMIT = symbolId(paths.withRateLimit, "withRateLimit")
const LOGIN_HANDLER = symbolId(paths.login, "loginHandler")

const occurrences: SymbolOccurrence[] = [
  definition(RATE_LIMIT_CONFIG, paths.limits, 1),
  usage(RATE_LIMIT_CONFIG, paths.rateLimiter, 1),
  usage(RATE_LIMIT_CONFIG, paths.rateLimiter, 3),

  definition(LOGIN_RATE_LIMIT, paths.limits, 3),
  usage(LOGIN_RATE_LIMIT, paths.withRateLimit, 2),
  usage(LOGIN_RATE_LIMIT, paths.withRateLimit, 5),
  usage(LOGIN_RATE_LIMIT, paths.test, 2),
  usage(LOGIN_RATE_LIMIT, paths.test, 6),

  definition(API_ERROR, paths.http, 1),
  usage(API_ERROR, paths.withRateLimit, 3),
  usage(API_ERROR, paths.withRateLimit, 10),

  definition(CREATE_RATE_LIMITER, paths.rateLimiter, 3),
  usage(CREATE_RATE_LIMITER, paths.withRateLimit, 1),
  usage(CREATE_RATE_LIMITER, paths.withRateLimit, 5),
  usage(CREATE_RATE_LIMITER, paths.test, 1),
  usage(CREATE_RATE_LIMITER, paths.test, 5),

  definition(CHECK_LIMIT, paths.rateLimiter, 12),
  usage(CHECK_LIMIT, paths.withRateLimit, 9),
  usage(CHECK_LIMIT, paths.test, 6),
  usage(CHECK_LIMIT, paths.test, 8),

  definition(WITH_RATE_LIMIT, paths.withRateLimit, 7),
  usage(WITH_RATE_LIMIT, paths.login, 2),
  usage(WITH_RATE_LIMIT, paths.login, 4),

  definition(LOGIN_HANDLER, paths.login, 4),
]

const rankingInput: RankingInput = {
  files: files.map((file) => ({ path: file.path, churn: file.additions + file.deletions })),
  edges: fileEdges.map(([from, to]) => ({ from, to })),
}

const ranking = rankFiles(rankingInput, resolveRankingPolicy("foundations-first"))

// Parse-don't-validate: the fixture is a boundary too — parsing guarantees it
// conforms to the shared contract, catching drift the moment it happens.
export const pr42Analysis: AnalysisResult = analysisResultSchema.parse({
  engine: "fast",
  pr: {
    owner: "acme",
    repo: "webapp",
    number: 42,
    title: "Add login rate limiting",
    author: "octocat", // PR opener; the fixture viewer ("reviewer-dev") differs → Approve enabled
    baseSha: "a1b2c3d",
    headSha: "3f9c2e1",
    // An invented description so the fixture exercises the viewer end-to-end: headings, a task
    // checklist and a link — the markdown wrapper renders it, and the link routes through
    // openExternalUrl rather than navigating the webview.
    body: [
      "## What & why",
      "",
      "Login had **no throttling**, so credential-stuffing was cheap. This adds a token-bucket",
      "limiter (`src/lib/rateLimiter.ts`) behind `withRateLimit`, wired into the login route.",
      "",
      "### Checklist",
      "",
      "- [x] Limiter core + unit tests",
      "- [x] Middleware wrapper",
      "- [ ] Dashboard metrics (follow-up)",
      "",
      "See the [rate-limit RFC](https://example.com/rfc) for the chosen window and burst.",
    ].join("\n"),
    htmlUrl: "https://github.com/acme/webapp/pull/42",
  },
  files,
  symbols,
  edges,
  ranking,
  ghosts: [],
  occurrences,
})

export const pr42Paths = paths
