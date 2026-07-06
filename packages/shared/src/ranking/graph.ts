// The dependency graph the ranking core operates on. Pure topology, no churn:
// `from` depends on `to`. Nodes are CHANGED file paths only (§8.1).

export type DependencyEdge = {
  from: string
  to: string
}

export type DependencyGraph = {
  nodes: string[]
  edges: DependencyEdge[]
}

// Build the ranking graph from the §3 contract. Only FILE-level edges between two
// CHANGED files affect review order (§5 step 6): imports to unchanged files are
// recorded but never rank, and symbol-level edges add precision elsewhere.
export function toDependencyGraph(
  files: ReadonlyArray<{ path: string }>,
  edges: ReadonlyArray<{ from: string; to: string; level: "file" | "symbol" }>
): DependencyGraph {
  const changed = new Set(files.map((file) => file.path))

  const dependencyEdges = edges
    .filter((edge) => edge.level === "file")
    .filter((edge) => changed.has(edge.from) && changed.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to }))

  return { nodes: files.map((file) => file.path), edges: dependencyEdges }
}
