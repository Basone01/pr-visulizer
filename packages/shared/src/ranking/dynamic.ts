import { comparePathAscending } from "./compare.js"
import type { DependencyGraph } from "./graph.js"
import { directDependencies, fanIns, topoLevels } from "./topo.js"

// Dynamic "best next" — recomputed after every checkmark (§8.2).

// readiness(f) = reviewed changed-deps of f / total changed-deps of f.
// A file with no changed deps has readiness 1.0 ("full context right now").
export function readiness(
  graph: DependencyGraph,
  reviewedFiles: Iterable<string>
): Map<string, number> {
  const reviewed = new Set(reviewedFiles)
  const dependencies = directDependencies(graph)

  const scores = new Map<string, number>()
  for (const node of graph.nodes) {
    const deps = dependencies.get(node)!

    if (deps.size === 0) {
      scores.set(node, 1)
      continue
    }

    let reviewedCount = 0
    for (const dep of deps) {
      if (reviewed.has(dep)) reviewedCount += 1
    }

    scores.set(node, reviewedCount / deps.size)
  }

  return scores
}

// The "best next" for FOUNDATIONS mode (§8.2):
// next = unreviewed file with max readiness,
//        tie → lower topoLevel → higher fanIn → path ascending.
// Returns null when nothing is left to review (the algorithm never blocks — it guides).
//
// Deliberately order-agnostic: it answers "what is ready", not "what order". In branch mode
// that is the wrong question — see `suggestNextInOrder` below.
export function suggestNext(
  graph: DependencyGraph,
  reviewedFiles: Iterable<string>
): string | null {
  const reviewed = new Set(reviewedFiles)
  const candidates = graph.nodes.filter((node) => !reviewed.has(node))

  if (candidates.length === 0) return null

  const scores = readiness(graph, reviewed)
  const levels = topoLevels(graph)
  const fans = fanIns(graph)

  const ranked = [...candidates].sort((a, b) => {
    const byReadiness = scores.get(b)! - scores.get(a)!
    if (byReadiness !== 0) return byReadiness

    const byLevel = levels.get(a)! - levels.get(b)!
    if (byLevel !== 0) return byLevel

    const byFanIn = fans.get(b)! - fans.get(a)!
    if (byFanIn !== 0) return byFanIn

    return comparePathAscending(a, b)
  })

  return ranked[0]!
}

// The "best next" for BRANCH mode (§8.4): the first unreviewed file in the branch order.
//
// Why not readiness here. Readiness maximises "what has full context right now" across the
// WHOLE graph, so on a PR whose changed files form two disjoint dependency chains it happily
// alternates between them — every chain's foundation has readiness 1.0. The tray, meanwhile,
// walks one chain start→end. The user follows the highlight and is thrown into an unrelated
// part of the PR on every checkmark (the PR #1087 report).
//
// Following the branch order instead keeps the suggestion inside the current chain until it is
// exhausted. Nothing is lost: the branch order is a post-order DFS, so a file's changed
// dependencies are always emitted before it — the first unreviewed file always has every
// changed dependency already behind it in the queue, which is what readiness measured.
export function suggestNextInOrder(
  orderedPaths: readonly string[],
  reviewedFiles: Iterable<string>
): string | null {
  const reviewed = new Set(reviewedFiles)

  return orderedPaths.find((path) => !reviewed.has(path)) ?? null
}
