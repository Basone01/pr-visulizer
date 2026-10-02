import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { startDevBridge } from "./devBridge"

const BRIDGE_ORIGIN = "http://127.0.0.1:7331"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type FetchCall = {
  url: URL
  init: RequestInit | undefined
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

describe("startDevBridge", () => {
  let stopBridge: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    document.title = "PR Review Visualizer"
    window.history.replaceState(null, "", "/review?tab=graph")
  })

  afterEach(() => {
    stopBridge?.()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("registers one UUID app identity on poll and result requests", async () => {
    // Arrange
    const commandId = "b1a5460b-2c77-416e-abac-4572dc206b06"
    const calls: FetchCall[] = []
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })

      if (url.pathname === "/poll") {
        return Promise.resolve(
          response([
            { id: commandId, expiresAt: Date.now() + 1_000, cmd: "click", selector: "#run" },
          ])
        )
      }

      return Promise.resolve(response({ ok: true }))
    })
    vi.stubGlobal("fetch", fetchMock)
    document.body.innerHTML = '<button id="run">Run</button>'
    stopBridge = startDevBridge()

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    const pollCall = calls.find((call) => call.url.pathname === "/poll")
    const resultCall = calls.find((call) => call.url.pathname === "/result")
    const resultBody = JSON.parse(String(resultCall?.init?.body)) as {
      appId: string
      id: string
      result: unknown
    }
    const expected = {
      pollOrigin: BRIDGE_ORIGIN,
      pollName: "PR Review Visualizer",
      pollUrl: `${window.location.origin}/review`,
      commandId,
      result: true,
    }
    expect({
      pollAppIdIsUuid: UUID_PATTERN.test(pollCall?.url.searchParams.get("appId") ?? ""),
      resultAppIdIsUuid: UUID_PATTERN.test(resultBody.appId),
      sameAppId: pollCall?.url.searchParams.get("appId") === resultBody.appId,
      pollOrigin: pollCall?.url.origin,
      pollName: pollCall?.url.searchParams.get("name"),
      pollUrl: pollCall?.url.searchParams.get("url"),
      commandId: resultBody.id,
      result: resultBody.result,
    }).toEqual({
      pollAppIdIsUuid: true,
      resultAppIdIsUuid: true,
      sameAppId: true,
      ...expected,
    })
  })

  it("does not execute a command that expired before the bridge received it", async () => {
    // Arrange
    const clicks: string[] = []
    const calls: FetchCall[] = []
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })

      if (url.pathname === "/poll") {
        return Promise.resolve(
          response([
            {
              id: "9769d855-59a7-40eb-9ccd-29c58a428e87",
              expiresAt: Date.now() - 1,
              cmd: "click",
              selector: "#expired",
            },
          ])
        )
      }

      return Promise.resolve(response({ ok: true }))
    })
    vi.stubGlobal("fetch", fetchMock)
    document.body.innerHTML = '<button id="expired">Expired</button>'
    document.querySelector("#expired")?.addEventListener("click", () => clicks.push("clicked"))
    stopBridge = startDevBridge()

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect({
      clicks,
      resultCount: calls.filter((call) => call.url.pathname === "/result").length,
    }).toEqual({ clicks: [], resultCount: 0 })
  })

  it("runs queued commands in order, then resumes polling", async () => {
    // Arrange
    const firstCommandId = "1c2f19fc-67bd-4f06-8a18-3e93e9c83650"
    const secondCommandId = "e956c0a6-e79e-49b4-8296-fd74f95d4fc7"
    const events: string[] = []
    const calls: FetchCall[] = []
    const pollResponses = [
      [
        {
          id: firstCommandId,
          expiresAt: Date.now() + 1_000,
          cmd: "eval",
          expression:
            "new Promise((resolve) => setTimeout(() => { document.querySelector('#first')?.dispatchEvent(new Event('click')); resolve('first') }, 50))",
        },
        { id: secondCommandId, expiresAt: Date.now() + 1_000, cmd: "click", selector: "#second" },
      ],
      [],
    ]
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })

      if (url.pathname === "/poll") return Promise.resolve(response(pollResponses.shift() ?? []))

      return Promise.resolve(response({ ok: true }))
    })
    vi.stubGlobal("fetch", fetchMock)
    document.body.innerHTML = '<button id="first">First</button><button id="second">Second</button>'
    document.querySelector("#first")?.addEventListener("click", () => events.push("first"))
    document.querySelector("#second")?.addEventListener("click", () => events.push("second"))
    stopBridge = startDevBridge()

    // Act
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(100)

    // Assert
    const resultIds = calls
      .filter((call) => call.url.pathname === "/result")
      .map((call) => JSON.parse(String(call.init?.body)).id)
    const pollCalls = calls.filter((call) => call.url.pathname === "/poll")
    expect({ events, resultIds, pollCount: pollCalls.length }).toEqual({
      events: ["first", "second"],
      resultIds: [firstCommandId, secondCommandId],
      pollCount: 2,
    })
  })

  it("continues with the next command when an eval expression expires while unresolved", async () => {
    // Arrange
    const hangingCommandId = "e2bf493b-3d4e-45c5-8874-1d9b33ff2182"
    const nextCommandId = "47a2a31b-e9a6-40f1-a17e-7f0ad9c50c40"
    const clicks: string[] = []
    const calls: FetchCall[] = []
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })

      if (url.pathname === "/poll") {
        return Promise.resolve(
          response([
            {
              id: hangingCommandId,
              expiresAt: Date.now() + 50,
              cmd: "eval",
              expression: "new Promise(() => {})",
            },
            {
              id: nextCommandId,
              expiresAt: Date.now() + 1_000,
              cmd: "click",
              selector: "#next",
            },
          ])
        )
      }

      return Promise.resolve(response({ ok: true }))
    })
    vi.stubGlobal("fetch", fetchMock)
    document.body.innerHTML = '<button id="next">Next</button>'
    document.querySelector("#next")?.addEventListener("click", () => clicks.push("next"))
    stopBridge = startDevBridge()

    // Act
    await vi.advanceTimersByTimeAsync(50)

    // Assert
    const resultBodies = calls
      .filter((call) => call.url.pathname === "/result")
      .map(
        (call) =>
          JSON.parse(String(call.init?.body)) as { id: string; result?: unknown; error?: unknown }
      )
    expect({
      clicks,
      resultIds: resultBodies.map((body) => body.id),
      expiredCommandError: typeof resultBodies[0]?.error === "string",
      nextCommandResult: resultBodies[1]?.result,
    }).toEqual({
      clicks: ["next"],
      resultIds: [hangingCommandId, nextCommandId],
      expiredCommandError: true,
      nextCommandResult: true,
    })
  })

  it("reports concise errors for BigInt and cyclic eval results", async () => {
    // Arrange
    const bigintCommandId = "f808992c-19bb-4e88-aee5-42339b1d8815"
    const cyclicCommandId = "ef03eeec-19ff-4032-a812-0abbea7b7d9e"
    const calls: FetchCall[] = []
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })

      if (url.pathname === "/poll") {
        return Promise.resolve(
          response([
            { id: bigintCommandId, expiresAt: Date.now() + 1_000, cmd: "eval", expression: "1n" },
            {
              id: cyclicCommandId,
              expiresAt: Date.now() + 1_000,
              cmd: "eval",
              expression: "(() => { const value = {}; value.self = value; return value })()",
            },
          ])
        )
      }

      return Promise.resolve(response({ ok: true }))
    })
    vi.stubGlobal("fetch", fetchMock)
    stopBridge = startDevBridge()

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    const resultBodies = calls
      .filter((call) => call.url.pathname === "/result")
      .map((call) => ({
        body: String(call.init?.body),
        parsed: JSON.parse(String(call.init?.body)),
      }))
    expect({
      resultIds: resultBodies.map(({ parsed }) => parsed.id),
      errorsAreStrings: resultBodies.every(({ parsed }) => typeof parsed.error === "string"),
      bodiesAreSmall: resultBodies.every(
        ({ body }) => new TextEncoder().encode(body).byteLength < 1_000
      ),
    }).toEqual({
      resultIds: [bigintCommandId, cyclicCommandId],
      errorsAreStrings: true,
      bodiesAreSmall: true,
    })
  })

  it("stops before a late poll response can execute commands or schedule another poll", async () => {
    // Arrange
    const commandId = "59b5f3d6-5c68-4b13-82d1-6d49075c9d25"
    const delayedPoll = deferred<Response>()
    const clicks: string[] = []
    const calls: FetchCall[] = []
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })

      if (url.pathname === "/poll") return delayedPoll.promise

      return Promise.resolve(response({ ok: true }))
    })
    vi.stubGlobal("fetch", fetchMock)
    document.body.innerHTML = '<button id="late">Late</button>'
    document.querySelector("#late")?.addEventListener("click", () => clicks.push("clicked"))
    stopBridge = startDevBridge()
    await vi.advanceTimersByTimeAsync(0)

    // Act
    stopBridge()
    delayedPoll.resolve(
      response([{ id: commandId, expiresAt: Date.now() + 1_000, cmd: "click", selector: "#late" }])
    )
    await vi.advanceTimersByTimeAsync(2_000)

    // Assert
    const expectedPollCount = 1
    expect({
      clicks,
      resultCount: calls.filter((call) => call.url.pathname === "/result").length,
      pollCount: calls.filter((call) => call.url.pathname === "/poll").length,
    }).toEqual({ clicks: [], resultCount: 0, pollCount: expectedPollCount })
  })
})
