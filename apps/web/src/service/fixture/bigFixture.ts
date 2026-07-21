import {
  type AnalysisResult,
  type ChangedFile,
  type ChangedSymbol,
  type Edge,
  type GhostFile,
  type SymbolOccurrence,
  analysisResultSchema,
  rankFiles,
  resolveRankingPolicy,
} from "@pr-visulizer/shared"

// DEV-ONLY profiling fixture: a synthetic N-file PR to reproduce the "clicking a node is
// slow on a big PR" report under a profiler. Served by the fixture client when the PR
// number is BIG_FIXTURE_NUMBER. Not a product path — kept out of any real flow.

export const BIG_FIXTURE_NUMBER = 999

const FILE_COUNT = 120

function bigFiles(): ChangedFile[] {
  return Array.from({ length: FILE_COUNT }, (_unused, index) => ({
    path: `src/module${Math.floor(index / 10)}/file${index}.ts`,
    status: index % 5 === 0 ? ("added" as const) : ("modified" as const),
    additions: (index % 30) + 1,
    deletions: index % 12,
    language: "typescript",
  }))
}

// A chain-ish edge set so the graph has real depth and ~1.5 edges/node.
function bigEdges(files: ChangedFile[]): Edge[] {
  const edges: Edge[] = []
  for (let i = 1; i < files.length; i++) {
    const to = files[Math.floor(i / 2)]!.path
    const from = files[i]!.path
    if (from === to) continue

    edges.push({ from, to, kind: "imports", level: "file", source: "ast" })
  }
  return edges
}

// ~5 symbols per changed file, and each symbol used from ~8 other files (deep-mode
// occurrences are repo-wide). This is what my first synthetic lacked — the anchor
// overlay and per-line symbol data the diff renderer actually processes.
function bigSymbolsAndOccurrences(files: ChangedFile[]): {
  symbols: ChangedSymbol[]
  occurrences: SymbolOccurrence[]
} {
  const symbols: ChangedSymbol[] = []
  const occurrences: SymbolOccurrence[] = []

  files.forEach((file, fileIndex) => {
    for (let s = 0; s < 5; s++) {
      const startLine = 10 + s * 6
      const id = `${file.path}#Symbol${s}`
      symbols.push({
        id,
        path: file.path,
        name: `Symbol${fileIndex}_${s}`,
        kind: "function",
        span: { startLine, endLine: startLine + 4 },
        changeKind: "modified",
      })
      occurrences.push({ symbolId: id, path: file.path, line: startLine, role: "definition" })

      for (let u = 0; u < 8; u++) {
        const userFile = files[(fileIndex + u + 1) % files.length]!
        occurrences.push({
          symbolId: id,
          path: userFile.path,
          line: 12 + u * 7,
          role: "usage",
        })
      }
    }
  })

  return { symbols, occurrences }
}

// One ghost (§6: unchanged file referencing changed code) so the ghost-view path is exercisable
// in fixture mode: it uses two of file0's changed symbols at three known lines of GHOST_HEAD.
export const GHOST_PATH = "src/module0/ghostConsumer.ts"
const GHOST_SYMBOLS = ["src/module0/file0.ts#Symbol0", "src/module0/file0.ts#Symbol1"]
const GHOST_REF_LINES = [4, 9, 17]

export const GHOST_HEAD = [
  'import { Symbol0_0, Symbol0_1 } from "./file0"',
  "",
  "export function consumeChanged(): number {",
  "  const first = Symbol0_0()",
  "  return first + 1",
  "}",
  "",
  "export function consumeAgain(): number {",
  "  return Symbol0_0() * 2",
  "}",
  "",
  "// A block of untouched lines so the ghost view has room to scroll.",
  "export const GHOST_CONSTANT = 42",
  "",
  "export function tail(): number {",
  "  // the last reference sits down here",
  "  return Symbol0_1(GHOST_CONSTANT)",
  "}",
  "",
].join("\n")

function ghostOccurrences(): SymbolOccurrence[] {
  return GHOST_REF_LINES.map((line, index) => ({
    symbolId: GHOST_SYMBOLS[index % GHOST_SYMBOLS.length]!,
    path: GHOST_PATH,
    line,
    role: "usage" as const,
  }))
}

// Extra ghosts with no head text behind them, so the fixture's ghost BAND wraps to a real grid
// instead of a single node. They keep the "content unavailable" ghost view reachable too — only
// GHOST_PATH above serves head content.
const EXTRA_GHOST_COUNT = 7

function ghostFiles(): GhostFile[] {
  const extras = Array.from({ length: EXTRA_GHOST_COUNT }, (_unused, index) => ({
    path: `src/module${index % 3}/ghostReader${index}.ts`,
    // Varying reference counts, so the band shows the same "N refs" spread a real deep run does.
    usedChangedSymbols: GHOST_SYMBOLS.slice(0, (index % GHOST_SYMBOLS.length) + 1),
  }))

  return [{ path: GHOST_PATH, usedChangedSymbols: GHOST_SYMBOLS }, ...extras]
}

export function buildBigAnalysis(owner: string, repo: string): AnalysisResult {
  const files = bigFiles()
  const edges = bigEdges(files)
  const { symbols, occurrences } = bigSymbolsAndOccurrences(files)

  const rankingInput: RankingInputShape = {
    files: files.map((file) => ({ path: file.path, churn: file.additions + file.deletions })),
    edges: edges.map((edge) => ({ from: edge.from, to: edge.to })),
  }
  const ranking = rankFiles(rankingInput, resolveRankingPolicy())

  return analysisResultSchema.parse({
    engine: "deep",
    pr: {
      owner,
      repo,
      number: BIG_FIXTURE_NUMBER,
      title: `Synthetic ${FILE_COUNT}-file PR (profiling)`,
      author: "octocat",
      baseSha: "base999",
      headSha: "head999",
    },
    files,
    symbols,
    edges,
    ranking,
    ghosts: ghostFiles(),
    occurrences: [...occurrences, ...ghostOccurrences()],
  })
}

type RankingInputShape = Parameters<typeof rankFiles>[0]

export function bigPatch(path: string): string {
  // A large-ish real-world-sized diff so opening a file exercises the line renderer.
  const lines = Array.from({ length: 600 }, (_unused, index) => `+  const value${index} = ${index}`)
  return `diff --git a/${path} b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.join("\n")}\n`
}
