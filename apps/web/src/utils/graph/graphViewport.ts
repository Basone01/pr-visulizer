// Zoom policy for the dependency-graph pane (docs/architecture.md §2.1).
//
// React Flow's own defaults are minZoom 0.5 / maxZoom 2, and fitView does NOT compute a free
// zoom — it runs getViewportForBounds(bounds, w, h, minZoom, maxZoom, padding), which CLAMPS to
// those limits. Measured on the 120-file fixture: the viewport came back as exactly `scale(0.5)`
// with 32 of 129 nodes rendered, because the graph actually needs ~0.11 to frame. The initial
// view showed a fraction of the graph and the ghost band — which sits below the changed files —
// never came on screen at all.
//
// So the floor is load-bearing twice over: it decides how much of a big PR fitView can frame, and
// it decides how far the reviewer may zoom out by hand. 0.5 was too high for both.

export type GraphZoomPolicy = {
  min: number // how far out the pane may zoom — also fitView's floor
  max: number // how far in the reviewer may zoom
  // Ceiling for the INITIAL fit only. Without it a 3-node PR would be magnified to fill the pane;
  // 1 keeps a small graph at its natural size while leaving a big one free to zoom out.
  initialFitMax: number
  // Floor applied when panning to the OPEN file. Framing a 120-file graph lands around 0.11,
  // where a node is an unreadable smudge — so selecting a file zooms back in to at least this.
  // 0.5 is not a taste call: it is the zoom the pane was previously pinned at, so a click now
  // reads exactly as legibly as it always did. Only ever raises the zoom, never lowers it, so a
  // reviewer who deliberately zoomed in keeps their view.
  focusMinZoom: number
}

export const DEFAULT_GRAPH_ZOOM_POLICY: GraphZoomPolicy = {
  min: 0.05,
  max: 2,
  initialFitMax: 1,
  focusMinZoom: 0.5,
}
