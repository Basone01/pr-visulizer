import type {
  AnalysisProgressFn,
  GatewayChangedFile,
  PrecisionPolicy,
} from "@pr-visulizer/engine/browser"
import type { AnalysisResult, PrMeta } from "@pr-visulizer/shared"

import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from "./analysisWorkerProtocol"

// Main-thread side of the analysis worker (docs/tauri-architecture.md §6): post the sources,
// relay progress, resolve with the result, and ALWAYS terminate the worker — one worker per
// analysis run keeps its memory (parsed trees over a whole repo) reclaimable the moment the
// run ends. The worker factory is injectable because jsdom has no Worker: tests drive the
// protocol against a scripted fake, and only the live desktop run proves the real spawn.

// The narrow slice of the Worker API this runner uses (and a fake must implement).
export type WorkerLike = {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void
}

// Vite's worker pattern: the URL is statically analyzable, so the bundler emits the worker
// (and its imports) as its own module-graph entry.
export function createAnalysisWorker(): WorkerLike {
  return new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" })
}

export type AnalysisSources = {
  pr: PrMeta
  files: GatewayChangedFile[]
  contents: Map<string, string>
  // deep-v2: omitted or disabled → the worker never imports `typescript`.
  precision?: PrecisionPolicy
}

// How long the precise phase may keep the worker alive AFTER the AST result has arrived. The
// engine caps the phase itself (`phaseTimeoutMs`); this is the outer belt-and-braces, because
// a worker killed by the OS — the memory-pressure case on a very large PR — fires NO error
// event, so without a deadline the promise simply never settles and the UI freezes on the last
// progress step it saw (which is why "stuck on precise-linking" was the reported symptom).
const PRECISE_PHASE_GRACE_MS = 60_000

export function runAnalysisInWorker(
  sources: AnalysisSources,
  onProgress?: AnalysisProgressFn,
  createWorker: () => WorkerLike = createAnalysisWorker
): Promise<AnalysisResult> {
  const worker = createWorker()

  const request: AnalysisWorkerRequest = {
    type: "analyze",
    pr: sources.pr,
    files: sources.files,
    contents: Object.fromEntries(sources.contents),
    ...(sources.precision ? { precision: sources.precision } : {}),
  }

  return new Promise<AnalysisResult>((resolve, reject) => {
    // The AST-only result, if the worker got that far. It is a complete, valid analysis.
    let astResult: AnalysisResult | null = null
    let watchdog: ReturnType<typeof setTimeout> | undefined

    const settle = (settler: () => void): void => {
      if (watchdog !== undefined) clearTimeout(watchdog)
      worker.terminate()
      settler()
    }

    // Degrade, never hang: whatever went wrong, if we hold the AST result we return it.
    const settleDegraded = (reason: string): void => {
      if (astResult) {
        console.warn(`[analysis] ${reason}; falling back to the AST-only result`)
        const degraded = astResult
        settle(() => resolve(degraded))
        return
      }

      settle(() => reject(new Error(reason)))
    }

    worker.addEventListener("message", (event: MessageEvent) => {
      // The worker is our own same-app code posting a schema-validated result (the pure core's
      // final zod gate) — structured clone preserves it, so no second parse on this side.
      const response = event.data as AnalysisWorkerResponse

      if (response.type === "progress") {
        onProgress?.(response.progress)
        return
      }

      if (response.type === "partial") {
        // The AST tier is done; only the precise phase remains. Arm the watchdog now, so the
        // clock covers exactly the phase that can hang, not the honest work before it.
        astResult = response.result
        watchdog = setTimeout(
          () => settleDegraded("precise phase exceeded its deadline"),
          PRECISE_PHASE_GRACE_MS
        )
        return
      }

      if (response.type === "result") settle(() => resolve(response.result))
      else settleDegraded(response.message)
    })

    worker.addEventListener("error", (event: { message?: string }) => {
      settleDegraded(event.message ?? "analysis worker crashed")
    })

    worker.postMessage(request)
  })
}
