import type { Edge } from "@pr-visulizer/shared"

import type { FileNodeVM } from "@/entity/viewModels"

// The graph content a selected commit range leaves visible (docs/architecture.md §10). The same
// narrowing the review tray applies, so the two panes always agree about which files the range
// touched — and, like the tray, it FILTERS without re-ranking: a surviving node keeps its
// whole-PR order number, so "#4" means the same thing in the graph and in the queue.
export type VisibleGraph = {
  fileNodes: FileNodeVM[]
  fileEdges: Edge[]
  // The paths actually drawn. Focus/dimming has to check this before highlighting a node — the
  // open file can be one the range filtered out.
  paths: ReadonlySet<string>
}

// `touchedPaths` null means NO range: the whole PR, exactly as before this feature. An empty set
// is a different thing — a range that touches nothing here — and correctly empties the graph.
//
// Only file-level edges shape the graph and the ranking (§5 step 6), so that filter lives here
// too: one place decides what the graph is made of.
export function rangeVisibleGraph(
  fileNodes: FileNodeVM[],
  edges: Edge[],
  touchedPaths: ReadonlySet<string> | null
): VisibleGraph {
  const fileEdges = edges.filter((edge) => edge.level === "file")

  if (!touchedPaths) {
    return { fileNodes, fileEdges, paths: new Set(fileNodes.map((node) => node.path)) }
  }

  const visibleNodes = fileNodes.filter((node) => touchedPaths.has(node.path))
  const paths = new Set(visibleNodes.map((node) => node.path))

  // Both endpoints must survive. React Flow logs error008 ("Couldn't create edge for source
  // handle id …") for an edge pointing at a node that isn't in its store, and an edge crossing
  // the filter boundary is exactly that — the dependency it names is off the canvas.
  //
  // Membership is tested against the DRAWN paths, not against touchedPaths: that set also
  // carries pre-rename names and files the graph has no node for.
  const visibleEdges = fileEdges.filter((edge) => paths.has(edge.from) && paths.has(edge.to))

  return { fileNodes: visibleNodes, fileEdges: visibleEdges, paths }
}
