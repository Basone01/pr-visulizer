import {
  type LayoutEdge,
  type LayoutNode,
  type NodePosition,
  buildElkGraph,
  readPositions,
} from "@/utils/graph/elkLayout"

import { runElkGraphInWorker } from "./runElkGraphInWorker"

// The PR dependency graph's layout, run in elk's web worker (see runElkGraphInWorker for why it
// never runs on the main thread).

export type ElkLayoutOptions = {
  signal?: AbortSignal
}

export async function runElkLayoutInWorker(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: ElkLayoutOptions = {}
): Promise<Map<string, NodePosition>> {
  const laidOut = await runElkGraphInWorker(buildElkGraph(nodes, edges), options.signal)
  return readPositions(laidOut)
}
