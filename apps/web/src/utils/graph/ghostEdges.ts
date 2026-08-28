import type { GhostNodeVM } from "@/entity/viewModels"

// The dashed ghost → changed-file links the graph draws (docs/architecture.md §6, §380). They are
// a RENDER-ONLY layer: they never reach elk (buildElkGraph drops ghosts, and these edges with
// them) and they are not part of `analysis.edges`, so neither the layered layout nor the ranking
// can shift because an unchanged file happens to import a changed one.
export type GhostEdge = {
  id: string
  from: string // the ghost
  to: string // the changed file it references
}

// `visiblePaths` is what the commit-range filter left on the canvas (rangeVisibleGraph). An edge
// to a file that isn't drawn is a dangling endpoint — React Flow logs error008 for it — so those
// are dropped here rather than at the renderer.
export function buildGhostEdges(
  ghostNodes: readonly GhostNodeVM[],
  visiblePaths: ReadonlySet<string>
): GhostEdge[] {
  return ghostNodes.flatMap((ghost) =>
    ghost.usesChangedFiles
      .filter((path) => visiblePaths.has(path))
      .map((path) => ({ id: `ghost:${ghost.path}->${path}`, from: ghost.path, to: path }))
  )
}
