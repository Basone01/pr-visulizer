import type {
  ChangedFile,
  DependencyEdge,
  DependencyGraph,
  Edge,
  RankingInput,
} from "../../src/index.js"

// PR #42 — "Add login rate limiting" (docs/architecture.md §7).
// The single worked example every §7–§8 number is asserted against.

export const pr42Paths = {
  limits: "src/config/limits.ts",
  http: "src/types/http.ts",
  rateLimiter: "src/lib/rateLimiter.ts",
  withRateLimit: "src/middleware/withRateLimit.ts",
  login: "src/api/routes/login.ts",
  test: "src/lib/rateLimiter.test.ts",
} as const

// The 6 changed files with their real churn (additions/deletions from the §7 table).
export const pr42Files: ChangedFile[] = [
  { path: pr42Paths.limits, status: "added", additions: 4, deletions: 0, language: "typescript" },
  { path: pr42Paths.http, status: "modified", additions: 2, deletions: 1, language: "typescript" },
  {
    path: pr42Paths.rateLimiter,
    status: "added",
    additions: 48,
    deletions: 0,
    language: "typescript",
  },
  {
    path: pr42Paths.withRateLimit,
    status: "added",
    additions: 26,
    deletions: 0,
    language: "typescript",
  },
  { path: pr42Paths.login, status: "modified", additions: 6, deletions: 2, language: "typescript" },
  { path: pr42Paths.test, status: "added", additions: 52, deletions: 0, language: "typescript" },
]

// File-level dependency edges, `from` depends on `to` (§7).
export const pr42FileEdges: DependencyEdge[] = [
  { from: pr42Paths.rateLimiter, to: pr42Paths.limits },
  { from: pr42Paths.withRateLimit, to: pr42Paths.rateLimiter },
  { from: pr42Paths.withRateLimit, to: pr42Paths.http },
  { from: pr42Paths.withRateLimit, to: pr42Paths.limits },
  { from: pr42Paths.login, to: pr42Paths.withRateLimit },
  { from: pr42Paths.test, to: pr42Paths.rateLimiter },
  { from: pr42Paths.test, to: pr42Paths.limits },
]

// The same edges as the §3 contract shape — for the boundary-schema round-trip test.
export const pr42ContractEdges: Edge[] = pr42FileEdges.map((edge) => ({
  from: edge.from,
  to: edge.to,
  kind: "imports",
  level: "file",
  source: "ast",
}))

// Input to the static ranking (churn derived from the file list).
export const pr42RankingInput: RankingInput = {
  files: pr42Files.map((file) => ({
    path: file.path,
    churn: file.additions + file.deletions,
  })),
  edges: pr42FileEdges,
}

// The dependency graph the dynamic best-next operates on.
export const pr42Graph: DependencyGraph = {
  nodes: pr42Files.map((file) => file.path),
  edges: pr42FileEdges,
}
