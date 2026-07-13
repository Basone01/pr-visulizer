import type { AnalysisProgress } from "@pr-visulizer/engine/browser"
import { describe, expect, it, vi } from "vitest"

import { pr42Analysis } from "@/service/fixture/pr42"

import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from "./analysisWorkerProtocol"
import { type WorkerLike, runAnalysisInWorker } from "./runAnalysisInWorker"

// The worker PROTOCOL, driven against a scripted fake — jsdom cannot spawn a real Worker, so
// this proves the main-thread side: the request shape (plain-object contents), progress
// relay, result resolution, error rejection, and the always-terminate guarantee. What only
// the live desktop run can prove: the real `new Worker(new URL(...))` spawn, the wasm fetch
// inside the worker, and structured-clone performance on a big repo.

type Scripted = {
  worker: WorkerLike
  received: unknown[]
  terminated: () => boolean
  emit: (response: AnalysisWorkerResponse) => void
}

function scriptedWorker(): Scripted {
  const received: unknown[] = []
  let messageListener: ((event: MessageEvent) => void) | null = null
  let terminated = false

  const worker: WorkerLike = {
    postMessage(message: unknown) {
      received.push(message)
    },
    terminate() {
      terminated = true
    },
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === "message") messageListener = listener as (event: MessageEvent) => void
    },
  }

  return {
    worker,
    received,
    terminated: () => terminated,
    emit: (response) => messageListener?.({ data: response } as MessageEvent),
  }
}

const sources = {
  pr: pr42Analysis.pr,
  files: [],
  contents: new Map([["src/a.ts", "export const a = 1\n"]]),
}

describe("runAnalysisInWorker — protocol", () => {
  it("posts the analyze request with plain-object contents, relays progress, resolves the result", async () => {
    // Arrange
    const scripted = scriptedWorker()
    const seenProgress: AnalysisProgress[] = []
    const parsingProgress: AnalysisProgress = { step: "parsing", done: 1, total: 1 }

    // Act
    const running = runAnalysisInWorker(
      sources,
      (progress) => seenProgress.push(progress),
      () => scripted.worker
    )
    scripted.emit({ type: "progress", progress: parsingProgress })
    scripted.emit({ type: "result", result: pr42Analysis })
    const result = await running

    // Assert
    const expectedRequest: AnalysisWorkerRequest = {
      type: "analyze",
      pr: pr42Analysis.pr,
      files: [],
      contents: { "src/a.ts": "export const a = 1\n" },
    }
    expect(scripted.received).toEqual([expectedRequest])
    expect(seenProgress).toEqual([parsingProgress])
    expect(result).toEqual(pr42Analysis)
    expect(scripted.terminated()).toBe(true)
  })

  it("rejects on a worker error response and still terminates the worker", async () => {
    // Arrange
    const scripted = scriptedWorker()
    const failureMessage = "grammar wasm failed to load"

    // Act
    const running = runAnalysisInWorker(sources, undefined, () => scripted.worker)
    scripted.emit({ type: "error", message: failureMessage })

    // Assert
    await expect(running).rejects.toThrow(failureMessage)
    expect(scripted.terminated()).toBe(true)
  })
})

// Degrade, never hang (task #9). Two ways the analysis used to freeze forever:
//   - the OS kills the worker under memory pressure: no `error` event ever fires
//   - the deep-v2 precise phase hangs: the worker simply stops talking
// In both cases the promise never settled and the UI sat on its last progress step —
// "precise-linking" — which is exactly what the user reported. The worker now posts the
// AST-only result BEFORE the precise phase, and a watchdog settles with it.
function scriptedWorkerWithError(): Scripted & { fail: (message: string) => void } {
  const received: unknown[] = []
  let messageListener: ((event: MessageEvent) => void) | null = null
  let errorListener: ((event: { message?: string }) => void) | null = null
  let terminated = false

  const worker: WorkerLike = {
    postMessage(message: unknown) {
      received.push(message)
    },
    terminate() {
      terminated = true
    },
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === "message") messageListener = listener as (event: MessageEvent) => void
      if (type === "error") errorListener = listener as (event: { message?: string }) => void
    },
  }

  return {
    worker,
    received,
    terminated: () => terminated,
    emit: (response) => messageListener?.({ data: response } as MessageEvent),
    fail: (message) => errorListener?.({ message }),
  }
}

describe("runAnalysisInWorker — the precise phase can never hang the analysis", () => {
  it("settles with the ast-only result when the worker goes silent after the partial", async () => {
    // Arrange — the worker posts the AST result, then never speaks again (killed, or hung).
    vi.useFakeTimers()
    const scripted = scriptedWorkerWithError()
    const pending = runAnalysisInWorker(sources, undefined, () => scripted.worker)
    scripted.emit({ type: "partial", result: pr42Analysis })

    // Act — let the watchdog fire.
    const watchdogMs = 60_000
    await vi.advanceTimersByTimeAsync(watchdogMs + 1)
    const result = await pending

    // Assert — a complete analysis, and the worker was torn down.
    expect(result).toEqual(pr42Analysis)
    expect(scripted.terminated()).toBe(true)
    vi.useRealTimers()
  })

  it("settles with the ast-only result when the worker crashes after the partial", async () => {
    // Arrange
    const scripted = scriptedWorkerWithError()
    const pending = runAnalysisInWorker(sources, undefined, () => scripted.worker)
    scripted.emit({ type: "partial", result: pr42Analysis })

    // Act
    scripted.fail("worker terminated by the OS")
    const result = await pending

    // Assert — degrade, not reject.
    expect(result).toEqual(pr42Analysis)
    expect(scripted.terminated()).toBe(true)
  })

  it("still rejects when the worker dies BEFORE any result exists", async () => {
    // Arrange — nothing to degrade to.
    const scripted = scriptedWorkerWithError()
    const pending = runAnalysisInWorker(sources, undefined, () => scripted.worker)
    const expectedMessage = "worker terminated by the OS"

    // Act
    scripted.fail(expectedMessage)

    // Assert
    await expect(pending).rejects.toThrow(expectedMessage)
    expect(scripted.terminated()).toBe(true)
  })

  it("prefers the final precise result over the partial when both arrive", async () => {
    // Arrange
    const scripted = scriptedWorkerWithError()
    const pending = runAnalysisInWorker(sources, undefined, () => scripted.worker)
    const preciseResult = { ...pr42Analysis, engine: "deep" as const }

    // Act
    scripted.emit({ type: "partial", result: pr42Analysis })
    scripted.emit({ type: "result", result: preciseResult })

    // Assert
    await expect(pending).resolves.toEqual(preciseResult)
  })
})
