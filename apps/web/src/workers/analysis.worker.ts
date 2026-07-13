import { analyzeDeepFromSources } from "@pr-visulizer/engine/browser"

import { createBrowserGrammarSource } from "@/utils/engineAssets/grammarSource"
import { createBrowserLibSource } from "@/utils/engineAssets/libSource"

import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from "./analysisWorkerProtocol"

// The analysis Web Worker (docs/tauri-architecture.md §6): the deep CPU pipeline off the main
// thread, so a 100+-file PR never freezes the webview. It imports ONLY the browser-safe engine
// core + the grammar seam — no Tauri APIs (they don't exist in a worker; the main thread did
// all the I/O already). The tree-sitter wasms load here via the same bundled `?url` assets the
// page uses — a plain same-origin fetch, which works in workers.

// The worker global, typed narrowly: the web tsconfig carries the DOM lib (not webworker),
// where `self.postMessage` has the window signature — this cast scopes the two members the
// worker actually uses to their worker-side shapes.
type WorkerScope = {
  postMessage(message: AnalysisWorkerResponse): void
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null
}

const scope = self as unknown as WorkerScope

// One grammar source for the worker's lifetime — its parser/grammar instances cache inside
// the analyzer per call, and the wasm bytes are fetched at most once per grammar.
const grammarSource = createBrowserGrammarSource()

// The type-library seam for the deep-v2 tier. Constructing it is free — the `?raw` chunks only
// load when the engine actually calls it.
const libSource = createBrowserLibSource()

scope.onmessage = (event) => {
  const request = event.data
  if (request.type !== "analyze") return

  void (async () => {
    try {
      const result = await analyzeDeepFromSources({
        pr: request.pr,
        files: request.files,
        contents: new Map(Object.entries(request.contents)),
        grammarSource,
        onProgress: (progress) => scope.postMessage({ type: "progress", progress }),
        onAstResult: (result) => scope.postMessage({ type: "partial", result }),
        ...(request.precision?.enabled
          ? { precision: { policy: request.precision, libSource } }
          : {}),
      })

      scope.postMessage({ type: "result", result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      scope.postMessage({ type: "error", message })
    }
  })()
}
