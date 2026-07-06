import type { RankedFile } from "../entities/analysis.js"
import { comparePathAscending } from "./compare.js"
import type { DependencyEdge, DependencyGraph } from "./graph.js"
import type { RankingPolicy, RankingPrimary, RankingTieBreaker } from "./policy.js"
import { fanIns, topoLevels } from "./topo.js"

// Static order — "where to start", computed once per analysis (§8.1).

export type RankingFileInput = {
  path: string
  churn: number // additions + deletions
  blastRadius?: number // deep engine only — passed through to the RankedFile
}

export type RankingInput = {
  files: RankingFileInput[]
  edges: DependencyEdge[] // file-level dependency edges: `from` depends on `to`
}

type FileMetric = {
  path: string
  topoLevel: number
  fanIn: number
  churn: number
}

type Comparator = (a: FileMetric, b: FileMetric) => number

// One comparator per criterion, each carrying its own direction:
// topoLevel ascending (foundations first), fanIn/churn descending (more first),
// churnAsc ascending (quick wins first), path ascending.
const CRITERION_COMPARATORS: Record<RankingPrimary | RankingTieBreaker, Comparator> = {
  topoLevel: (a, b) => a.topoLevel - b.topoLevel,
  fanIn: (a, b) => b.fanIn - a.fanIn,
  churn: (a, b) => b.churn - a.churn,
  churnAsc: (a, b) => a.churn - b.churn,
  path: (a, b) => comparePathAscending(a.path, b.path),
}

function buildGraph(input: RankingInput): DependencyGraph {
  const nodes = input.files.map((file) => file.path)
  const changed = new Set(nodes)
  const edges = input.edges.filter((edge) => changed.has(edge.from) && changed.has(edge.to))

  return { nodes, edges }
}

function sortByPolicy(metrics: FileMetric[], policy: RankingPolicy): FileMetric[] {
  // `path` is appended as an ultimate tie-break so the order is always total,
  // even if a custom policy omits it.
  const criteria = [policy.primary, ...policy.tieBreakers, "path"] as const
  const comparators = criteria.map((criterion) => CRITERION_COMPARATORS[criterion])

  return [...metrics].sort((a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b)
      if (result !== 0) return result
    }

    return 0
  })
}

function toRankedFile(metric: FileMetric, index: number, source: RankingFileInput): RankedFile {
  const ranked: RankedFile = {
    path: metric.path,
    topoLevel: metric.topoLevel,
    fanIn: metric.fanIn,
    churn: metric.churn,
    order: index + 1,
  }

  // exactOptionalPropertyTypes: only set the optional field when it exists.
  if (source.blastRadius !== undefined) ranked.blastRadius = source.blastRadius

  return ranked
}

// Produce the precomputed static order: topoLevel + fanIn per file, sorted by the
// policy, numbered 1..n. Pure — the same input always yields the same ranking.
export function rankFiles(input: RankingInput, policy: RankingPolicy): RankedFile[] {
  const graph = buildGraph(input)
  const levels = topoLevels(graph)
  const fans = fanIns(graph)

  const metrics: FileMetric[] = input.files.map((file) => ({
    path: file.path,
    topoLevel: levels.get(file.path)!,
    fanIn: fans.get(file.path)!,
    churn: file.churn,
  }))

  const byPath = new Map(input.files.map((file) => [file.path, file]))

  return sortByPolicy(metrics, policy).map((metric, index) =>
    toRankedFile(metric, index, byPath.get(metric.path)!)
  )
}
