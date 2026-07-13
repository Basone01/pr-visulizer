import type {
  AnalysisProgress,
  GatewayChangedFile,
  PrecisionPolicy,
} from "@pr-visulizer/engine/browser"
import type { AnalysisResult, PrMeta } from "@pr-visulizer/shared"

// The analysis-worker message protocol (docs/tauri-architecture.md §6). The MAIN thread does
// ALL I/O — Tauri plugin APIs and `window.__TAURI_INTERNALS__` do not exist inside a worker —
// and posts the already-read sources here; the worker runs the pure deep core and streams
// progress + the result back. Payloads are plain objects (`contents` a Record, not a Map) so
// they structured-clone cheaply and the protocol stays inspectable in devtools.

export type AnalysisWorkerRequest = {
  type: "analyze"
  pr: PrMeta
  files: GatewayChangedFile[]
  // path → content at headSha, already candidate-filtered and size-capped by the main thread.
  contents: Record<string, string>
  // deep-v2: the precision tier's settings. The LibSource is NOT sent — it is platform-local
  // to the worker (a `?raw` glob), exactly like the grammar source.
  precision?: PrecisionPolicy
}

export type AnalysisWorkerResponse =
  | { type: "progress"; progress: AnalysisProgress }
  // The AST-only result, posted BEFORE the deep-v2 precise phase starts. The main thread keeps
  // it: if the precise phase hangs, or the OS kills this worker (which fires no error event),
  // the analysis still settles with a complete graph instead of spinning forever.
  | { type: "partial"; result: AnalysisResult }
  | { type: "result"; result: AnalysisResult }
  | { type: "error"; message: string }
