import {
  type AnalysisResult,
  type ChangedSymbol,
  type DependencyEdge,
  type Edge,
  type PrMeta,
  type RankingPolicy,
  type SymbolOccurrence,
  analysisResultSchema,
  rankFiles,
  resolveRankingPolicy,
} from "@pr-visulizer/shared"

import { headHunkRanges, rangesIntersect } from "../../utils/diffHunks.js"
import { familyOfGrammar, languageForPath } from "../../utils/language.js"
import { resolveToKnownPath } from "../../utils/modulePath.js"
import type { GatewayChangedFile } from "../githubGateway/index.js"
import { type ParsedSource, type ResolvedReference, resolveRepo } from "./deepResolve.js"
import type { AnalysisProgressFn } from "./engine.js"
import { heuristicImports } from "./heuristic.js"
import {
  type GrammarSource,
  type ModuleSymbol,
  type ModuleSyntax,
  type SyntaxAnalyzer,
  createSyntaxAnalyzer,
} from "./treeSitter.js"

// The PURE CPU core of the fast engine (docs/architecture.md §5, steps 4–9). All I/O — PR
// meta + changed files (steps 1–2) and content fetches (step 3) — happens in the wrapper
// (fastEngine.ts) or, in the desktop, on the main thread; this function only receives the
// already-read sources and produces the AnalysisResult. No gateway, no cache, no network —
// so the exact same code runs in the node BFF and inside a browser Web Worker.

// A parsed changed file: its metadata + extracted syntax + whether it fell back to
// the import-regex heuristic (no grammar) — which tags its edges source:'heuristic'.
type ParsedFile = {
  file: GatewayChangedFile
  syntax: ModuleSyntax
  heuristic: boolean
}

type ResolvedBinding = {
  targetPath: string
  importedName: string
}

// §5 step 5: which symbols in a file count as changed, and how.
function symbolChangeKind(
  file: GatewayChangedFile
): (symbol: ModuleSymbol) => ChangedSymbol["changeKind"] | null {
  if (file.status === "added") return () => "added"
  if (file.status === "deleted") return () => "deleted"

  // Modified/renamed: a symbol is "changed" only if its span intersects a head hunk.
  const hunks = headHunkRanges(file.patch)
  return (symbol) => {
    const touched = hunks.some((hunk) =>
      rangesIntersect(hunk, { startLine: symbol.startLine, endLine: symbol.endLine })
    )
    return touched ? "modified" : null
  }
}

// §5 step 4: parse each changed file, or fall back to the heuristic when no grammar. Parsing
// is CPU work, kept sequential; `onParse` reports done/total for the parsing progress step.
async function parseFiles(
  analyzer: SyntaxAnalyzer,
  files: GatewayChangedFile[],
  contents: Array<string | undefined>,
  onParse?: (done: number, total: number) => void
): Promise<ParsedFile[]> {
  const parsed: ParsedFile[] = []

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!
    const content = contents[index]
    const grammarId = languageForPath(file.path)

    if (grammarId && content !== undefined) {
      const syntax = await analyzer.analyzeSyntax(grammarId, content)
      parsed.push({ file, syntax, heuristic: false })
    } else {
      const imports = content === undefined ? [] : heuristicImports(content)
      parsed.push({ file, syntax: { symbols: [], imports, references: [] }, heuristic: true })
    }

    onParse?.(index + 1, files.length)
  }

  return parsed
}

// §5 step 4/5: build the changed-symbol set with an id/path index for edge resolution.
function buildSymbols(parsed: ParsedFile[]): {
  symbols: ChangedSymbol[]
  byId: Map<string, ChangedSymbol>
  byPath: Map<string, ChangedSymbol[]>
} {
  const symbols: ChangedSymbol[] = []
  const byId = new Map<string, ChangedSymbol>()
  const byPath = new Map<string, ChangedSymbol[]>()

  for (const { file, syntax } of parsed) {
    const changeKindOf = symbolChangeKind(file)
    const bucket: ChangedSymbol[] = []

    for (const raw of syntax.symbols) {
      const changeKind = changeKindOf(raw)
      if (!changeKind) continue

      const symbol: ChangedSymbol = {
        id: `${file.path}#${raw.name}`,
        path: file.path,
        name: raw.name,
        kind: raw.kind,
        span: { startLine: raw.startLine, endLine: raw.endLine },
        changeKind,
      }

      symbols.push(symbol)
      byId.set(symbol.id, symbol)
      bucket.push(symbol)
    }

    byPath.set(file.path, bucket)
  }

  return { symbols, byId, byPath }
}

// §5 step 6: resolve imports to file-level edges (changed → changed) and, per file,
// the local-name → target binding map that powers symbol resolution in step 7.
function buildFileEdges(
  parsed: ParsedFile[],
  changedPaths: ReadonlySet<string>
): {
  edges: Edge[]
  depEdges: DependencyEdge[]
  bindingsByPath: Map<string, Map<string, ResolvedBinding>>
} {
  const edges = new Map<string, Edge>()
  const depEdges: DependencyEdge[] = []
  const bindingsByPath = new Map<string, Map<string, ResolvedBinding>>()

  for (const { file, syntax, heuristic } of parsed) {
    const bindings = new Map<string, ResolvedBinding>()

    for (const moduleImport of syntax.imports) {
      const targetPath = resolveToKnownPath(file.path, moduleImport.specifier, changedPaths)
      if (!targetPath || targetPath === file.path) continue

      const edgeKey = `${file.path} ${targetPath}`
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          from: file.path,
          to: targetPath,
          kind: "imports",
          level: "file",
          source: heuristic ? "heuristic" : "ast",
        })
        depEdges.push({ from: file.path, to: targetPath })
      }

      for (const binding of moduleImport.bindings) {
        bindings.set(binding.localName, { targetPath, importedName: binding.importedName })
      }
    }

    bindingsByPath.set(file.path, bindings)
  }

  return { edges: [...edges.values()], depEdges, bindingsByPath }
}

// The innermost changed symbol whose span contains a line (a method wins over its
// enclosing class). Attributes a reference to the symbol whose body it sits in (§7).
function innermostContaining(symbols: ChangedSymbol[], line: number): ChangedSymbol | null {
  let best: ChangedSymbol | null = null

  for (const symbol of symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue

    const span = symbol.span.endLine - symbol.span.startLine
    if (!best || span < best.span.endLine - best.span.startLine) best = symbol
  }

  return best
}

// §5 step 7: resolve call/type references inside changed symbols to symbol-level edges,
// recording a definition + usage SymbolOccurrence for every resolution (§10's data).
function buildSymbolEdges(
  parsed: ParsedFile[],
  bindingsByPath: Map<string, Map<string, ResolvedBinding>>,
  symbolsByPath: Map<string, ChangedSymbol[]>,
  symbolById: Map<string, ChangedSymbol>
): { edges: Edge[]; occurrences: SymbolOccurrence[] } {
  const edges = new Map<string, Edge>()
  const occurrences = new Map<string, SymbolOccurrence>()

  const recordOccurrence = (occurrence: SymbolOccurrence): void => {
    const key = `${occurrence.symbolId} ${occurrence.path} ${occurrence.line} ${occurrence.role}`
    if (!occurrences.has(key)) occurrences.set(key, occurrence)
  }

  for (const { file, syntax } of parsed) {
    const bindings = bindingsByPath.get(file.path)
    const changedInFile = symbolsByPath.get(file.path)
    if (!bindings || bindings.size === 0 || !changedInFile || changedInFile.length === 0) continue

    for (const reference of syntax.references) {
      const binding = bindings.get(reference.name)
      if (!binding) continue

      const container = innermostContaining(changedInFile, reference.line)
      if (!container) continue

      const target = symbolById.get(`${binding.targetPath}#${binding.importedName}`)
      if (!target) continue

      const kind = reference.kind === "call" ? "calls" : "uses-type"
      const edgeKey = `${container.id} ${target.id} ${kind}`
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          from: container.id,
          to: target.id,
          kind,
          level: "symbol",
          source: "ast",
        })
      }

      recordOccurrence({
        symbolId: target.id,
        path: file.path,
        line: reference.line,
        role: "usage",
      })
      recordOccurrence({
        symbolId: target.id,
        path: target.path,
        line: target.span.startLine,
        role: "definition",
      })
    }
  }

  return { edges: [...edges.values()], occurrences: [...occurrences.values()] }
}

// Map a resolved reference's kind to the edge kind (§3) — a value use → "uses", distinct from a
// call ("calls") and a type use ("uses-type"). Mirrors the deep engine's mapping.
function edgeKindForReference(kind: ResolvedReference["kind"]): Edge["kind"] {
  if (kind === "call") return "calls"
  if (kind === "use") return "uses"

  return "uses-type"
}

// The PHP/Python file + symbol edges (docs/architecture.md §5, "More languages"). TS relative
// resolution (step 6) is `.ts/.js`-shaped and Go is directory-based, so PHP `use`/`require` and
// Python dotted/relative imports need their OWN specifier resolution — which is exactly what the
// per-family resolvers in `deepResolve` already do. We reuse `resolveRepo` over just the CHANGED
// PHP/Python files, resolving against the CHANGED-file set only.
//
// Same honesty and known misses as deep mode, tightened by the fast engine's horizon: it holds
// only the changed files, so — exactly like TS aliased specifiers here — a PHP namespace-suffix
// or Python dotted import resolves ONLY when its target is itself a changed file; a dependency on
// an unchanged file is invisible until deep mode reads the whole checkout.
function buildForeignEdges(
  parsed: ParsedFile[],
  changedPaths: ReadonlySet<string>,
  symbolsByPath: Map<string, ChangedSymbol[]>,
  symbolById: Map<string, ChangedSymbol>
): {
  fileEdges: Edge[]
  symbolEdges: Edge[]
  depEdges: DependencyEdge[]
  occurrences: SymbolOccurrence[]
} {
  const foreignSources: ParsedSource[] = []
  for (const { file, syntax, heuristic } of parsed) {
    if (heuristic) continue

    const grammarId = languageForPath(file.path)
    if (!grammarId) continue

    const family = familyOfGrammar(grammarId)
    if (family === "php" || family === "python") {
      foreignSources.push({ path: file.path, grammarId, syntax })
    }
  }

  if (foreignSources.length === 0) {
    return { fileEdges: [], symbolEdges: [], depEdges: [], occurrences: [] }
  }

  // Resolve against the changed files only — no go.mod, no tsconfig aliases in fast mode.
  const resolution = resolveRepo(foreignSources, changedPaths, null)

  const fileEdges = new Map<string, Edge>()
  const depEdges: DependencyEdge[] = []
  for (const { from, to } of resolution.fileImports) {
    if (from === to || !changedPaths.has(from) || !changedPaths.has(to)) continue

    const key = `${from} ${to}`
    if (fileEdges.has(key)) continue

    fileEdges.set(key, { from, to, kind: "imports", level: "file", source: "ast" })
    depEdges.push({ from, to })
  }

  const symbolEdges = new Map<string, Edge>()
  const occurrences = new Map<string, SymbolOccurrence>()
  const recordOccurrence = (occurrence: SymbolOccurrence): void => {
    const key = `${occurrence.symbolId} ${occurrence.path} ${occurrence.line} ${occurrence.role}`
    if (!occurrences.has(key)) occurrences.set(key, occurrence)
  }

  for (const reference of resolution.references) {
    // The index holds only changed symbols, so every resolved target is a changed symbol.
    if (!symbolById.has(reference.target.id)) continue

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

    const containers = symbolsByPath.get(reference.fromPath)
    if (!containers) continue

    const container = innermostContaining(containers, reference.line)
    if (!container || container.id === reference.target.id) continue

    const kind = edgeKindForReference(reference.kind)
    const edgeKey = `${container.id} ${reference.target.id} ${kind}`
    if (!symbolEdges.has(edgeKey)) {
      symbolEdges.set(edgeKey, {
        from: container.id,
        to: reference.target.id,
        kind,
        level: "symbol",
        source: "ast",
      })
    }
  }

  return {
    fileEdges: [...fileEdges.values()],
    symbolEdges: [...symbolEdges.values()],
    depEdges,
    occurrences: [...occurrences.values()],
  }
}

// Inputs the pure fast core needs — everything already read (no gateway, no fetch).
// `contents` is aligned index-for-index with `files`; a deleted file's slot is undefined.
export type FastSourcesInput = {
  pr: PrMeta
  files: GatewayChangedFile[]
  contents: Array<string | undefined>
  grammarSource: GrammarSource
  policy?: RankingPolicy
  onProgress?: AnalysisProgressFn
}

// The pure fast pipeline (steps 4–9). Given the sources, produce the validated
// AnalysisResult. Reports parsing / resolving / ranking progress; the caller reports the
// I/O-side fetching-pr / reading-files steps. Runs unchanged in node and in a Web Worker.
export async function analyzeFastFromSources(input: FastSourcesInput): Promise<AnalysisResult> {
  const { pr, files, contents } = input
  const report = input.onProgress
  const analyzer = createSyntaxAnalyzer(input.grammarSource)
  const policy = input.policy ?? resolveRankingPolicy()

  const changedPaths = new Set(files.map((file) => file.path))

  // Step 4: parse (or heuristic-fallback) (parsing progress).
  const parsed = await parseFiles(
    analyzer,
    files,
    contents,
    report ? (done, total) => report({ step: "parsing", done, total }) : undefined
  )

  // Steps 5: changed symbols; 6: file edges + bindings; 7: symbol edges + occurrences. TS/JS and
  // Go flow through the original path; PHP/Python resolve through their own per-family resolvers.
  report?.({ step: "resolving" })
  const { symbols, byId, byPath } = buildSymbols(parsed)
  const { edges: fileEdges, depEdges, bindingsByPath } = buildFileEdges(parsed, changedPaths)
  const { edges: symbolEdges, occurrences } = buildSymbolEdges(parsed, bindingsByPath, byPath, byId)
  const foreign = buildForeignEdges(parsed, changedPaths, byPath, byId)

  // Step 8: ranking from the shared core (§8) — foundations-first by default.
  report?.({ step: "ranking" })
  const ranking = rankFiles(
    {
      files: files.map((file) => ({ path: file.path, churn: file.additions + file.deletions })),
      edges: [...depEdges, ...foreign.depEdges],
    },
    policy
  )

  // Parse-don't-trust even our OWN output: the contract schema is the final gate.
  return analysisResultSchema.parse({
    engine: "fast",
    pr,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      language: file.language,
    })),
    symbols,
    edges: [...fileEdges, ...symbolEdges, ...foreign.fileEdges, ...foreign.symbolEdges],
    ranking,
    ghosts: [],
    occurrences: [...occurrences, ...foreign.occurrences],
  })
}
