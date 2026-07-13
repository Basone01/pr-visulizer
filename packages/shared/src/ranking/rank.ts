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

// Branch-first ordering (§8.4). Walk each dependency branch from its foundation to its top,
// keeping the branch contiguous, before starting the next. A post-order DFS from the entry
// points (files nothing else depends on — fanIn 0) emits every dependency before the file that
// needs it, so within a branch you read start→end; a foundation shared by two branches is
// emitted once, with the first branch that reaches it. Roots and each node's dependencies are
// visited in policy order, so the tie-breakers still decide branch order and the result is
// deterministic. Cyclic back-edges are broken by an on-stack guard; anything unreached (an
// isolated file, or a node only inside a cycle) is appended in policy order so the order is total.
function orderByBranch(
  metrics: FileMetric[],
  edges: DependencyEdge[],
  policy: RankingPolicy
): FileMetric[] {
  const byPath = new Map(metrics.map((metric) => [metric.path, metric]))
  const inPolicyOrder = sortByPolicy(metrics, policy)
  const policyIndex = new Map(inPolicyOrder.map((metric, index) => [metric.path, index]))

  const dependencies = new Map<string, string[]>(metrics.map((metric) => [metric.path, []]))
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (byPath.has(edge.from) && byPath.has(edge.to)) dependencies.get(edge.from)!.push(edge.to)
  }
  for (const list of dependencies.values()) {
    list.sort((a, b) => policyIndex.get(a)! - policyIndex.get(b)!)
  }

  const roots = inPolicyOrder.filter((metric) => metric.fanIn === 0)
  const entryPoints = roots.length > 0 ? roots : inPolicyOrder

  const ordered: FileMetric[] = []
  const emitted = new Set<string>()
  const onStack = new Set<string>()

  function visit(path: string): void {
    if (emitted.has(path) || onStack.has(path)) return

    onStack.add(path)
    for (const dependency of dependencies.get(path) ?? []) visit(dependency)
    onStack.delete(path)

    emitted.add(path)
    ordered.push(byPath.get(path)!)
  }

  for (const entry of entryPoints) visit(entry.path)
  for (const metric of inPolicyOrder) {
    if (!emitted.has(metric.path)) ordered.push(metric)
  }

  return ordered
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

  const ordered =
    policy.strategy === "branch"
      ? orderByBranch(metrics, graph.edges, policy)
      : sortByPolicy(metrics, policy)

  return ordered.map((metric, index) => toRankedFile(metric, index, byPath.get(metric.path)!))
}
