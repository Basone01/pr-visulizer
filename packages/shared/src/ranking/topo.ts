import type { DependencyGraph } from "./graph.js"

// Topological level and fan-in over the changed-file dependency graph (§8.1).
// Cyclic imports are collapsed with Tarjan's SCC so their members share a level
// (§5 fallback: "review together") — the graph is otherwise a DAG.

type SccResult = {
  // component index each node belongs to
  componentOf: Map<string, number>
  componentCount: number
}

function buildAdjacency(graph: DependencyGraph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()

  for (const node of graph.nodes) {
    adjacency.set(node, [])
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to)
  }

  return adjacency
}

// Tarjan's strongly-connected-components. Recursive: a PR graph is small
// (≤ 300 files, §5), so recursion depth is a non-issue and reads far cleaner.
function stronglyConnectedComponents(graph: DependencyGraph): SccResult {
  const adjacency = buildAdjacency(graph)

  const indexOf = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const componentOf = new Map<string, number>()

  let nextIndex = 0
  let componentCount = 0

  function strongConnect(node: string): void {
    indexOf.set(node, nextIndex)
    lowLink.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const next of adjacency.get(node) ?? []) {
      if (!indexOf.has(next)) {
        strongConnect(next)
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!))
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, indexOf.get(next)!))
      }
    }

    if (lowLink.get(node) !== indexOf.get(node)) return

    // Root of an SCC: pop the stack down to it — every popped node is one component.
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      componentOf.set(member, componentCount)
    } while (member !== node)

    componentCount += 1
  }

  for (const node of graph.nodes) {
    if (!indexOf.has(node)) strongConnect(node)
  }

  return { componentOf, componentCount }
}

// Condensation edges: dependencies between DISTINCT components form a DAG.
function buildComponentDeps(
  graph: DependencyGraph,
  componentOf: Map<string, number>,
  componentCount: number
): number[][] {
  const deps = Array.from({ length: componentCount }, () => new Set<number>())

  for (const edge of graph.edges) {
    const fromComponent = componentOf.get(edge.from)!
    const toComponent = componentOf.get(edge.to)!

    if (fromComponent !== toComponent) deps[fromComponent]!.add(toComponent)
  }

  return deps.map((set) => [...set])
}

// topoLevel(f) = 0 if f depends on no other changed file, else
// 1 + max(topoLevel of its changed dependencies). SCC members share a level.
export function topoLevels(graph: DependencyGraph): Map<string, number> {
  const { componentOf, componentCount } = stronglyConnectedComponents(graph)
  const componentDeps = buildComponentDeps(graph, componentOf, componentCount)

  const componentLevel = new Map<number, number>()

  function levelOf(componentId: number): number {
    const cached = componentLevel.get(componentId)
    if (cached !== undefined) return cached

    let level = 0
    for (const dependency of componentDeps[componentId] ?? []) {
      level = Math.max(level, 1 + levelOf(dependency))
    }

    componentLevel.set(componentId, level)
    return level
  }

  const levels = new Map<string, number>()
  for (const node of graph.nodes) {
    levels.set(node, levelOf(componentOf.get(node)!))
  }

  return levels
}

// fanIn(f) = how many DISTINCT changed files depend on f (§8.1).
export function fanIns(graph: DependencyGraph): Map<string, number> {
  const dependents = new Map<string, Set<string>>()

  for (const node of graph.nodes) {
    dependents.set(node, new Set())
  }

  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue

    dependents.get(edge.to)?.add(edge.from)
  }

  const counts = new Map<string, number>()
  for (const node of graph.nodes) {
    counts.set(node, dependents.get(node)!.size)
  }

  return counts
}

// Direct changed dependencies of each node (distinct out-neighbours, no self-loops).
// Powers the readiness fraction (§8.2).
export function directDependencies(graph: DependencyGraph): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>()

  for (const node of graph.nodes) {
    dependencies.set(node, new Set())
  }

  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue

    dependencies.get(edge.from)?.add(edge.to)
  }

  return dependencies
}
