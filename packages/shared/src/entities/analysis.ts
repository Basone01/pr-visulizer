import { z } from "zod"

// The contract (docs/architecture.md §3). Each schema is the single source of
// truth; the matching TypeScript type is INFERRED from it, never hand-written.
// Both engines (fast/deep) emit `AnalysisResult` — the SPA never knows which ran.

export const engineSchema = z.enum(["fast", "deep"])
export type Engine = z.infer<typeof engineSchema>

export const changedFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  // null = no tree-sitter grammar → heuristic mode (§5).
  language: z.string().nullable(),
})
export type ChangedFile = z.infer<typeof changedFileSchema>

export const changedSymbolSchema = z.object({
  id: z.string(), // `${path}#${name}`
  path: z.string(),
  name: z.string(),
  kind: z.enum(["function", "method", "class", "type", "const"]),
  span: z.object({
    startLine: z.number().int(),
    endLine: z.number().int(),
  }),
  changeKind: z.enum(["added", "modified", "deleted"]),
})
export type ChangedSymbol = z.infer<typeof changedSymbolSchema>

// `from → to` means "from DEPENDS ON to" — every algorithm assumes this direction.
export const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  // "uses" = a value reference to a const/var (e.g. Go `constant.TempKeyPrefix`), distinct
  // from "calls" (a function call) and "uses-type" (a type reference).
  kind: z.enum(["imports", "calls", "uses-type", "uses"]),
  level: z.enum(["file", "symbol"]),
  source: z.enum(["ast", "lsp", "heuristic"]), // which engine/fallback produced it
})
export type Edge = z.infer<typeof edgeSchema>

export const rankedFileSchema = z.object({
  path: z.string(),
  topoLevel: z.number().int().nonnegative(), // 0 = depends on no other CHANGED file
  fanIn: z.number().int().nonnegative(), // how many changed files depend on it
  churn: z.number().int().nonnegative(), // additions + deletions
  order: z.number().int().positive(), // 1-based position in the static order
  // deep engine only — UNCHANGED files that depend on it (risk badge).
  blastRadius: z.number().int().nonnegative().optional(),
})
export type RankedFile = z.infer<typeof rankedFileSchema>

// deep engine only: an unchanged file that references changed code. Context, never work.
export const ghostFileSchema = z.object({
  path: z.string(),
  usedChangedSymbols: z.array(z.string()),
})
export type GhostFile = z.infer<typeof ghostFileSchema>

// One place a symbol appears in the PR — powers def ↔ usage navigation (§10).
export const symbolOccurrenceSchema = z.object({
  symbolId: z.string(),
  path: z.string(),
  line: z.number().int(), // in the head version
  role: z.enum(["definition", "usage"]),
})
export type SymbolOccurrence = z.infer<typeof symbolOccurrenceSchema>

export const prMetaSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(), // the PR opener's login — GitHub forbids approving your own PR (§11)
  baseSha: z.string(),
  headSha: z.string(), // cache key — new push = new SHA = new analysis
  // The PR description viewer's two fields (GitHub REST `pulls.get`). `body` is the markdown
  // description — GitHub returns it as string|null (null = no description). `htmlUrl` is the PR's
  // web page. Both are OPTIONAL on the contract so the ~28 existing PrMeta fixtures need no churn;
  // the octokit gateway and the fixture client always populate them, so live data carries both.
  body: z.string().nullable().optional(),
  htmlUrl: z.string().optional(),
})
export type PrMeta = z.infer<typeof prMetaSchema>

// The instant-open payload (docs/architecture.md §9): PR meta + the changed-file list, with
// NO analysis. It is the cheap gateway read the SPA renders the shell from — the TopBar, the
// review-tray rows, and the first file's diff — while the (slower) AnalysisResult is still
// computing. The full result supersedes it once ready.
export const prOverviewSchema = z.object({
  pr: prMetaSchema,
  files: z.array(changedFileSchema),
})
export type PrOverview = z.infer<typeof prOverviewSchema>

// The output of the analysis pipeline. Immutable per (headSha, engine).
export const analysisResultSchema = z.object({
  engine: engineSchema,
  pr: prMetaSchema,
  files: z.array(changedFileSchema),
  symbols: z.array(changedSymbolSchema),
  edges: z.array(edgeSchema),
  ranking: z.array(rankedFileSchema), // precomputed static order (§8)
  ghosts: z.array(ghostFileSchema), // deep engine only
  occurrences: z.array(symbolOccurrenceSchema),
})
export type AnalysisResult = z.infer<typeof analysisResultSchema>
