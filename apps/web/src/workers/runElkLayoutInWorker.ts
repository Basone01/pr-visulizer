import ELK from "elkjs/lib/elk-api"
// elk ships its layout engine as a ready-made worker script, loaded here as a raw asset URL
// and run as a classic Worker. It must stay out of the module pipeline: elk-worker.min.js only
// installs its `self.onmessage` handler when it sees no CommonJS `module` around it.
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url"

import {
  type LayoutEdge,
  type LayoutNode,
  type NodePosition,
  buildElkGraph,
  readPositions,
} from "@/utils/graph/elkLayout"

// Main-thread side of elk's layout worker. elkjs' layered algorithm is synchronous CPU work:
// on a 400-file PR with hub nodes it runs for seconds, and on the main thread that is a frozen
// webview — the packaged WKWebView kills the content process outright.
//
// One ELK (and so one worker) per layout run: aborting the signal doesn't just discard a stale
// result, it terminates the CPU work still grinding behind it.

export type ElkLayoutOptions = {
  signal?: AbortSignal
}

export function runElkLayoutInWorker(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: ElkLayoutOptions = {}
): Promise<Map<string, NodePosition>> {
  const { signal } = options
  const elk = new ELK({ workerUrl: elkWorkerUrl })

  return new Promise<Map<string, NodePosition>>((resolve, reject) => {
    let settled = false

    // An aborted run still gets elk's own resolve/reject later — first one through wins, and
    // only it terminates the worker.
    const settle = (settler: () => void): void => {
      if (settled) return

      settled = true
      signal?.removeEventListener("abort", onAbort)
      elk.terminateWorker()
      settler()
    }

    function onAbort(): void {
      settle(() => reject(new DOMException("elk layout aborted", "AbortError")))
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort)

    elk
      .layout(buildElkGraph(nodes, edges))
      .then((laidOut) => settle(() => resolve(readPositions(laidOut))))
      .catch((error: unknown) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))))
      })
  })
}
