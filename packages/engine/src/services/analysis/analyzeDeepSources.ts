import {
  type AnalysisResult,
  type ChangedSymbol,
  type DependencyEdge,
  type Edge,
  type GhostFile,
  type PrMeta,
  type RankingFileInput,
  type RankingPolicy,
  type SymbolOccurrence,
  analysisResultSchema,
  changedFileFactsOf,
  rankReviewFiles,
  resolveRankingPolicy,
} from "@pr-visulizer/shared"

import { parseGoModulePath } from "../../utils/goMod.js"
import {
  familiesOfPaths,
  familyOfGrammar,
  isTypeScriptFamily,
  languageForPath,
} from "../../utils/language.js"
import { resolveToKnownPath } from "../../utils/modulePath.js"
import { basename } from "../../utils/posixPath.js"
import { throttleByCount } from "../../utils/progressThrottle.js"
import { type AliasTable, buildAliasTable } from "../../utils/tsconfigPaths.js"
import type { GatewayChangedFile } from "../githubGateway/index.js"
import {
  type ChangedFileSyntax,
  buildChangedSymbols,
  innermostContaining,
} from "./changedSymbols.js"
import { type ParsedSource, type ResolvedReference, resolveRepo } from "./deepResolve.js"
import type { AnalysisProgressFn } from "./engine.js"
import { importSpecifiers } from "./heuristic.js"
import type { PrecisionPolicy } from "./precise/policy.js"
import type { LibSource } from "./precise/tsLanguageService.js"
import { type GrammarSource, type ModuleSyntax, createSyntaxAnalyzer } from "./treeSitter.js"

// The PURE CPU core of the deep engine (docs/architecture.md §6). All I/O — PR meta +
// changed files (steps 1–2) and reading the WHOLE checkout at headSha — happens in the
// wrapper (deepEngine.ts) or, in the desktop, on the main thread (the RepoSource reads via
// Rust); this function only receives the already-read `contents` map and produces the
// AnalysisResult. No gateway, no cache, no filesystem — so this identical code runs in the
// node BFF/tests AND inside the desktop's browser Web Worker (the desktop's THE analysis).

// Repo-wide reading/parsing counts run into the thousands, so their progress callbacks are
// throttled to one every ~25 files (§6) — the UI updates smoothly instead of being flooded.
const DEEP_PROGRESS_THROTTLE = 25

// The default ghost cap — deep results are big and ghosts are context, not work (§6).
export const DEFAULT_MAX_GHOSTS = 50

// Map a resolved reference's kind to the edge kind (§3). A value reference to a const/var
// ("use") becomes a "uses" edge, distinct from a call ("calls") or a type use ("uses-type").
function edgeKindForReference(kind: ResolvedReference["kind"]): Edge["kind"] {
  if (kind === "call") return "calls"
  if (kind === "use") return "uses"

  return "uses-type"
}

// The root-most go.mod content, or null. v1 handles a single module; nested modules
// (a go.mod in a subdirectory) are a known miss — the shortest path wins as the root.
function findGoModule(contents: Map<string, string>): string | null {
  let rootPath: string | null = null
  for (const path of contents.keys()) {
    if (basename(path) !== "go.mod") continue
    if (rootPath === null || path.length < rootPath.length) rootPath = path
  }

  const content = rootPath === null ? undefined : contents.get(rootPath)
  return content === undefined ? null : parseGoModulePath(content)
}

// Symbol-level edges (changed → changed) + repo-wide occurrences for changed symbols.
// Occurrences include ghost-file usages (a resolved reference from an UNCHANGED file);
// edges require BOTH endpoints changed, exactly like the fast engine's step 7.
function buildSymbolLayer(
  resolution: ReturnType<typeof resolveRepo>,
  changed: {
    paths: ReadonlySet<string>
    symbolIds: ReadonlySet<string>
    byPath: Map<string, ChangedSymbol[]>
  }
): { edges: Edge[]; occurrences: SymbolOccurrence[] } {
  const edges = new Map<string, Edge>()
  const occurrences = new Map<string, SymbolOccurrence>()

  const recordOccurrence = (occurrence: SymbolOccurrence): void => {
    const key = `${occurrence.symbolId} ${occurrence.path} ${occurrence.line} ${occurrence.role}`
    if (!occurrences.has(key)) occurrences.set(key, occurrence)
  }

  for (const reference of resolution.references) {
    if (!changed.symbolIds.has(reference.target.id)) continue

    recordOccurrence({
      symbolId: reference.target.id,
      path: reference.fromPath,
      line: reference.line,
      role: "usage",
    })
    recordOccurrence({
      symbolId: reference.target.id,
      path: reference.target.path,
      line: reference.target.startLine,
      role: "definition",
    })

    if (!changed.paths.has(reference.fromPath)) continue

    const containers = changed.byPath.get(reference.fromPath)
    if (!containers) continue

    const container = innermostContaining(containers, reference.line)
    if (!container || container.id === reference.target.id) continue

    const kind = edgeKindForReference(reference.kind)
    const edgeKey = `${container.id} ${reference.target.id} ${kind}`
    if (!edges.has(edgeKey)) {
      edges.set(edgeKey, {
        from: container.id,
        to: reference.target.id,
        kind,
        level: "symbol",
        source: "ast",
      })
    }
  }

  return { edges: [...edges.values()], occurrences: [...occurrences.values()] }
}

// File-level dependency edges (changed → changed) for ranking, plus the raw dependency
// list. Two sources: import statements, AND references to ANY symbol defined in another
// changed file — even an unchanged one. The second is what links files whose changed
// lines are unrelated (a test exercising an unchanged struct from its changed sibling —
// Go same-package files have no import statement to catch), so the ranking still puts
// the definition before its dependents.
function buildFileLayer(
  resolution: ReturnType<typeof resolveRepo>,
  changedPaths: ReadonlySet<string>
): { edges: Edge[]; depEdges: DependencyEdge[] } {
  const edges = new Map<string, Edge>()
  const depEdges: DependencyEdge[] = []

  const addFileEdge = (from: string, to: string, kind: Edge["kind"]): void => {
    if (from === to || !changedPaths.has(from) || !changedPaths.has(to)) return

    const key = `${from} ${to}`
    if (edges.has(key)) return

    edges.set(key, { from, to, kind, level: "file", source: "ast" })
    depEdges.push({ from, to })
  }

  for (const { from, to } of resolution.fileImports) addFileEdge(from, to, "imports")

  for (const reference of resolution.references) {
    addFileEdge(reference.fromPath, reference.target.path, edgeKindForReference(reference.kind))
  }

  return { edges: [...edges.values()], depEdges }
}

type BlastAndGhosts = {
  blastRadius: Map<string, number> // changed file path → distinct unchanged dependents
  ghosts: GhostFile[]
}

// Ghosts (unchanged files that reference changed code) and blast radius (per changed
// file, the distinct unchanged files depending on it — via a symbol reference OR a file
// import). Ghosts are ordered by reference count and capped (§6: context, never work).
function buildBlastAndGhosts(
  resolution: ReturnType<typeof resolveRepo>,
  changed: { paths: ReadonlySet<string>; symbolIds: ReadonlySet<string> },
  maxGhosts: number
): BlastAndGhosts {
  const dependents = new Map<string, Set<string>>() // changed file → unchanged dependents
  const usedSymbols = new Map<string, Set<string>>() // ghost file → changed symbol ids
  const refCount = new Map<string, number>() // ghost file → total refs to changed code

  const addDependent = (changedFile: string, unchangedFile: string): void => {
    const set = dependents.get(changedFile) ?? new Set<string>()
    set.add(unchangedFile)
    dependents.set(changedFile, set)
  }

  const markGhost = (path: string): Set<string> => {
    const set = usedSymbols.get(path) ?? new Set<string>()
    usedSymbols.set(path, set)
    return set
  }

  for (const reference of resolution.references) {
    if (!changed.symbolIds.has(reference.target.id) || changed.paths.has(reference.fromPath))
      continue

    markGhost(reference.fromPath).add(reference.target.id)
    refCount.set(reference.fromPath, (refCount.get(reference.fromPath) ?? 0) + 1)
    addDependent(reference.target.path, reference.fromPath)
  }

  for (const { from, to } of resolution.fileImports) {
    if (!changed.paths.has(to) || changed.paths.has(from)) continue

    markGhost(from)
    addDependent(to, from)
  }

  // The same fact read the other way round: ghost file → the changed files it reaches. Both
  // loops above feed `dependents`, so an import-only ghost (no changed symbol referenced) still
  // names the file it imports — that's the faded edge the graph draws (§6, §380).
  const usesChangedFiles = new Map<string, Set<string>>()
  for (const [changedFile, unchangedFiles] of dependents) {
    for (const unchangedFile of unchangedFiles) {
      const uses = usesChangedFiles.get(unchangedFile) ?? new Set<string>()
      uses.add(changedFile)
      usesChangedFiles.set(unchangedFile, uses)
    }
  }

  const ghosts: GhostFile[] = [...usedSymbols.entries()]
    .map(([path, ids]) => ({
      path,
      usedChangedSymbols: [...ids].sort(),
      usesChangedFiles: [...(usesChangedFiles.get(path) ?? [])].sort(),
    }))
    .sort((a, b) => {
      const byCount = (refCount.get(b.path) ?? 0) - (refCount.get(a.path) ?? 0)
      return byCount !== 0 ? byCount : a.path < b.path ? -1 : 1
    })
    .slice(0, maxGhosts)

  const blastRadius = new Map<string, number>()
  for (const [path, set] of dependents) blastRadius.set(path, set.size)

  return { blastRadius, ghosts }
}

// Keep every Go file (cheap), and of the TS-family files keep only those that can contribute:
// the changed ones, plus their DIRECT importers (the ghost / blast-radius set).
//
// Adjacency comes from the heuristic regex import scan — a text pass over the sources, ~9 ms
// for a thousand files. Text scanning is free; the wasm parse is what we are rationing. The
// specifier is resolved with the engine's own resolver, so nearest-tsconfig `@/…` aliases,
// extension-less and index resolution behave exactly as they do in the real pass.
//
// Known, deliberate narrowing: a file that reaches a changed symbol only through a re-export
// barrel is not a direct importer. `deepResolve` cannot resolve that chain today either (the
// binding targets the barrel, whose `barrel#Name` is not in the definition index), so nothing
// that used to resolve stops resolving. If deepResolve ever follows re-export chains, this
// set must widen with it.
function restrictToReachable(
  familyTargets: Array<[string, string]>,
  changedPaths: ReadonlySet<string>,
  aliases: AliasTable
): Array<[string, string]> {
  const tsPaths = new Set(
    familyTargets.filter(([path]) => isTypeScriptFamily(path)).map(([path]) => path)
  )
  if (tsPaths.size === 0) return familyTargets

  const changedTs = new Set([...changedPaths].filter((path) => tsPaths.has(path)))
  if (changedTs.size === 0) return familyTargets.filter(([path]) => !isTypeScriptFamily(path))

  const keep = new Set(changedTs)
  for (const [path, text] of familyTargets) {
    if (!isTypeScriptFamily(path) || keep.has(path)) continue

    for (const specifier of importSpecifiers(text)) {
      const target = resolveToKnownPath(path, specifier, tsPaths, aliases)
      if (target !== null && changedTs.has(target)) {
        keep.add(path)
        break
      }
    }
  }

  return familyTargets.filter(([path]) => !isTypeScriptFamily(path) || keep.has(path))
}

// Inputs the pure deep core needs — everything already read (no gateway, no filesystem).
// `contents` is the whole checkout at headSha (path → source), post-scan. `goModulePath`
// defaults to the root go.mod's module path derived from `contents`; the desktop main
// thread may pass it explicitly. `maxGhosts` caps the ghost list.
export type DeepSourcesInput = {
  pr: PrMeta
  files: GatewayChangedFile[]
  contents: Map<string, string>
  grammarSource: GrammarSource
  goModulePath?: string | null
  // TS `paths` aliases; defaults to the table built from the tsconfigs in `contents`.
  aliases?: AliasTable
  maxGhosts?: number
  policy?: RankingPolicy
  onProgress?: AnalysisProgressFn
  // Called with the AST-only result the moment it exists, before the precision tier runs.
  // The desktop worker relays it so a hung/killed precise phase still yields a usable analysis.
  onAstResult?: (result: AnalysisResult) => void
  // deep-v2 (§6.2): the compiler-grade pass. Off unless a policy enables it AND the platform
  // supplies a `libSource` (node reads lib.*.d.ts off disk; the webview imports `?raw` assets).
  // The `typescript` module is imported lazily below, so a disabled tier costs nothing.
  precision?: { policy: PrecisionPolicy; libSource: LibSource }
}

// The pure deep pipeline (parse → resolve → layers → ghosts → rank → validate). Given the
// whole-repo sources, produce the validated AnalysisResult. Reports parsing / resolving /
// ranking progress (parsing throttled over the grammar-having subset); the caller reports
// the I/O-side fetching-pr / reading-files steps. Runs unchanged in node and a Web Worker.
export async function analyzeDeepFromSources(input: DeepSourcesInput): Promise<AnalysisResult> {
  const { pr, files, contents } = input
  const report = input.onProgress
  const analyzer = createSyntaxAnalyzer(input.grammarSource)
  const policy = input.policy ?? resolveRankingPolicy()
  const maxGhosts = input.maxGhosts ?? DEFAULT_MAX_GHOSTS

  // Parse the repo-wide index, but only what can possibly contribute. Two cuts, both driven by
  // one fact: every consumer below (buildSymbolLayer, buildBlastAndGhosts, buildFileLayer)
  // DISCARDS a reference whose target is not a CHANGED symbol. So a file's parse pays off only
  // if it defines a changed symbol, or can reference one.
  //
  // The cuts matter because a TS-family parse is ruinously expensive: measured on this repo,
  // each one retains ~3.9 MB of wasm heap that is never reclaimed (969 TS files ≈ 3.8 GB, even
  // with `tree.delete()`), against 25 KB/file for Go. That allocation wedged the webview.
  const changedPaths = new Set(files.map((file) => file.path))

  // Derived from the checkout the caller already read, so the pure core gains no I/O. Needed
  // BEFORE the parse: the reachability cut resolves `@/…` specifiers to decide what to parse.
  const aliases = input.aliases ?? buildAliasTable(contents)

  // Cut 1 — FAMILY. Name resolution never crosses the Go/TS boundary (deepResolve splits on
  // it), so a Go-only PR gains nothing from parsing the repo's TypeScript.
  const changedFamilies = familiesOfPaths(changedPaths)
  const familyTargets = [...contents].filter(([path]) => {
    const grammar = languageForPath(path)
    return grammar !== null && changedFamilies.has(familyOfGrammar(grammar))
  })

  // Cut 2 — REACHABILITY, TS-family only (Go is cheap enough to index whole, and its
  // same-package resolution is directory-based rather than import-based).
  // A TS file can only bind to a changed symbol through a direct import of the changed file,
  // so the useful set is `changed ∪ direct importers`. Importers are what ghosts and blast
  // radius are made of — hence REVERSE edges, not what the changed files import.
  const parseTargets = restrictToReachable(familyTargets, changedPaths, aliases)
  const parseProgress = report
    ? throttleByCount(DEEP_PROGRESS_THROTTLE, (done, total) =>
        report({ step: "parsing", done, total })
      )
    : undefined

  const parsedSources: ParsedSource[] = []
  const syntaxByPath = new Map<string, ModuleSyntax>()
  let parsedCount = 0
  for (const [path, content] of parseTargets) {
    const grammarId = languageForPath(path)!

    const syntax = await analyzer.analyzeSyntax(grammarId, content)
    parsedSources.push({ path, grammarId, syntax })
    syntaxByPath.set(path, syntax)

    parsedCount += 1
    parseProgress?.(parsedCount, parseTargets.length)
  }
  const allPaths = new Set(syntaxByPath.keys())
  const goModulePath = input.goModulePath ?? findGoModule(contents)

  // Changed symbols come from the CHANGED files' head content (from the checkout). A
  // deleted or non-source changed file simply contributes no symbols.
  const changedParsed: ChangedFileSyntax[] = []
  for (const file of files) {
    const syntax = syntaxByPath.get(file.path)
    if (syntax) changedParsed.push({ file, syntax })
  }
  const { symbols, byPath: changedByPath } = buildChangedSymbols(changedParsed)
  const changedSymbolIds = new Set(symbols.map((symbol) => symbol.id))

  // Repo-wide resolution → the three layers.
  report?.({ step: "resolving" })
  const resolution = resolveRepo(parsedSources, allPaths, goModulePath, aliases)

  const symbolLayer = buildSymbolLayer(resolution, {
    paths: changedPaths,
    symbolIds: changedSymbolIds,
    byPath: changedByPath,
  })
  const fileLayer = buildFileLayer(resolution, changedPaths)
  const { blastRadius, ghosts } = buildBlastAndGhosts(
    resolution,
    { paths: changedPaths, symbolIds: changedSymbolIds },
    maxGhosts
  )

  // Ranking: changed files only (unchanged semantics, §8.3), with blastRadius attached
  // as the deep-only risk badge (0 when nothing unchanged depends on the file).
  report?.({ step: "ranking" })
  // A generated file stays in `files` but is never ranked. A file with an omitted part is.
  const { skipped: generatedFiles, omitted } = changedFileFactsOf(files)
  const { ranked: ranking, skipped } = rankReviewFiles(
    {
      files: files.map((file): RankingFileInput => ({
        path: file.path,
        churn: file.additions + file.deletions,
        blastRadius: blastRadius.get(file.path) ?? 0,
      })),
      edges: fileLayer.depEdges,
      skipped: generatedFiles,
    },
    policy
  )

  // Parse-don't-trust our OWN output: the contract schema is the final gate (§3).
  const astResult = analysisResultSchema.parse({
    engine: "deep",
    pr,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      language: file.language,
    })),
    symbols,
    edges: [...fileLayer.edges, ...symbolLayer.edges],
    ranking,
    ghosts,
    occurrences: symbolLayer.occurrences,
    // Only when present, so a result with neither is byte-identical to before.
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(omitted.length > 0 ? { omitted } : {}),
  })

  // Hand the AST result out BEFORE the precise phase. If the phase hangs — or the whole worker
  // is killed by the OS, which fires no error event — the caller still holds a complete result
  // and can settle with it instead of waiting forever. "Deep can only add" (§4.2), operationally.
  input.onAstResult?.(astResult)

  return applyPrecisionTier(astResult, symbols, contents, aliases, input)
}

// A hard wall-clock ceiling on an awaitable. Resolves to `onTimeout` if the work has not
// settled in time. The timer is cleared either way, so a resolved race never keeps the process
// (or a worker) alive on a dangling handle.
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms)
  })

  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// deep-v2 (§4.2 "deep can only add"): confirm/extend the AST edges with compiler-grade
// references. EVERY failure path returns the AST result untouched — a precision tier that can
// fail the analysis is worse than no precision tier. `typescript` is imported here, lazily, so
// a disabled tier never pulls the 9 MB module into the bundle's entry chunk.
async function applyPrecisionTier(
  astResult: AnalysisResult,
  symbols: ChangedSymbol[],
  contents: Map<string, string>,
  aliases: AliasTable,
  input: DeepSourcesInput
): Promise<AnalysisResult> {
  const precision = input.precision
  if (!precision?.policy.enabled || symbols.length === 0) return astResult

  // Gate BEFORE the lazy import: a PR that changed no TS/JS file can gain nothing from a
  // TypeScript program, so it must not pay the ~9 MB module or the repo-wide parse. (A Go-only
  // PR used to load all of it, then throw on its first Go symbol and discard the whole tier.)
  if (!symbols.some((symbol) => isTypeScriptFamily(symbol.path))) return astResult

  input.onProgress?.({ step: "precise-linking" })

  const precise = (async (): Promise<AnalysisResult> => {
    const [{ createTsReferenceIndex }, { mergePreciseEdges }] = await Promise.all([
      import("./precise/tsLanguageService.js"),
      import("./precise/mergePreciseEdges.js"),
    ])

    const index = await createTsReferenceIndex({
      contents,
      symbols,
      aliases,
      libSource: precision.libSource,
      policy: precision.policy,
    })
    if (!index) return astResult

    const references = await index.referencesTo(symbols.map((symbol) => symbol.id))
    return mergePreciseEdges(astResult, references).result
  })()

  // If the phase loses the race and only THEN rejects, that rejection has no listener left.
  // Attach a no-op handler; the race still sees the original rejection.
  precise.catch(() => {})

  try {
    // The hard ceiling on the WHOLE phase — asset preload, program build, every query. It can
    // only fire at an await boundary, which is why the query loop yields between chunks; a
    // single synchronous compiler call is still uninterruptible, by construction.
    return await withDeadline(precise, precision.policy.phaseTimeoutMs, astResult)
  } catch (error) {
    // Loud in the console, invisible in the product: the reviewer still gets their graph.
    console.warn("[deep-v2] precise linking unavailable; keeping the AST result", error)
    return astResult
  }
}
