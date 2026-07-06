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

// next = unreviewed file with max readiness,
//        tie → lower topoLevel → higher fanIn → path ascending.
// Returns null when nothing is left to review (the algorithm never blocks — it guides).
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
