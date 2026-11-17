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
  // The CHANGED files this ghost reaches — the faded edges the graph draws (§6, §380). Symbol
  // references AND plain imports both count, so an import-only ghost (empty usedChangedSymbols)
  // still names its files. Sorted and deduped. These edges never enter `edges` above: the ranking
  // is about changed files only, and a ghost must not shift it.
  usesChangedFiles: z.array(z.string()),
})
export type GhostFile = z.infer<typeof ghostFileSchema>

// Two separate facts about a changed file (docs/architecture.md §3, CONTRACT §11.1).
// GENERATED: build output or vendored code, on strong evidence only. It is not analysed, not
// ranked, listed after the ranked files and not counted toward completion.
export const skipReasonSchema = z.enum(["generated"])
export type SkipReason = z.infer<typeof skipReasonSchema>

// Why the app treats a file as generated. A label and an ordering decision, never a statement
// that the file is safe: the PR author controls every one of these (CONTRACT §11.2, G1).
// "file-name" = an unambiguous generated suffix, "dependency-folder" = under node_modules/,
// "build-folder-and-shape" = a build-like folder AND machine-made shape (over the cap, omitted
// by GitHub, or a line over 5,000 characters).
export const generatedEvidenceSchema = z.enum([
  "file-name",
  "dependency-folder",
  "build-folder-and-shape",
])
export type GeneratedEvidence = z.infer<typeof generatedEvidenceSchema>

export const skippedFileSchema = z.object({
  path: z.string(),
  reason: skipReasonSchema,
  evidence: generatedEvidenceSchema,
})
export type SkippedFile = z.infer<typeof skippedFileSchema>

// OMITTED: one part of a file could not be read. Only that part is missing: a file whose diff
// is omitted is still analysed by its content, still ranked and still counts toward completion.
// "diff" = its patch (over the cap, omitted by GitHub, or unreadable). "content" = its blob is
// over the engine's read limit, so it has no symbols.
export const omittedPartSchema = z.enum(["diff", "content"])
export type OmittedPart = z.infer<typeof omittedPartSchema>

export const omissionReasonSchema = z.enum(["too-large", "unreadable"])
export type OmissionReason = z.infer<typeof omissionReasonSchema>

export const fileOmissionSchema = z.object({
  path: z.string(),
  part: omittedPartSchema,
  reason: omissionReasonSchema,
  // The byte limit the part went over, when a known limit refused it.
  limitBytes: z.number().int().positive().optional(),
  // What the reader said, for an unreadable part.
  message: z.string().optional(),
})
export type FileOmission = z.infer<typeof fileOmissionSchema>

// One file's patch as the diff pane gets it: the patch, or why there is none to show.
export type FilePatch =
  | { kind: "patch"; patch: string }
  | { kind: "generated"; skip: SkippedFile }
  | { kind: "omitted"; omission: FileOmission }

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
  // Generated changed files, left out of the analysis and the ranking. Optional so older
  // results and fixtures stay valid: absent means none.
  skipped: z.array(skippedFileSchema).optional(),
  // Parts of changed files that could not be read. The files themselves stay in the review.
  omitted: z.array(fileOmissionSchema).optional(),
})
export type AnalysisResult = z.infer<typeof analysisResultSchema>
