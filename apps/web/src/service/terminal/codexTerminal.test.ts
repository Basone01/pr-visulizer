import { describe, expect, it, vi } from "vitest"

import type { ReviewSnapshot } from "@/entity/terminalReviewSnapshot"

import { startCodexTerminal } from "./codexTerminal"

const bridge = vi.hoisted(() => ({
  listen: vi.fn(),
  unlistenOutput: vi.fn(),
  unlistenExit: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: bridge.listen,
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }))

const START = {
  sessionId: "session-1",
  provider: "codex" as const,
  repositoryPath: "/repo",
  initialPrompt: "Review PR 42",
  model: "gpt-5.6-luna",
  rows: 24,
  cols: 80,
  context: {
    owner: "acme",
    repo: "webapp",
    number: 42,
    title: "Review PR",
    baseSha: "base",
    headSha: "head",
    selectedFilePath: null,
  },
}

function handlers() {
  return { onOutput: vi.fn(), onExit: vi.fn() }
}

describe("startCodexTerminal", () => {
  it("cleans_up_the_first_listener_when_the_second_listener_fails", async () => {
    // Arrange
    bridge.listen.mockReset()
    bridge.unlistenOutput.mockClear()
    bridge.invoke.mockClear()
    bridge.listen.mockResolvedValueOnce(bridge.unlistenOutput)
    bridge.listen.mockRejectedValueOnce(new Error("exit listener failed"))

    // Act
    const start = startCodexTerminal(START, handlers())

    // Assert
    await expect(start).rejects.toThrow("exit listener failed")
    expect(bridge.unlistenOutput).toHaveBeenCalledOnce()
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it("stops_the_child_when_attach_fails_after_start", async () => {
    // Arrange
    bridge.listen.mockReset()
    bridge.unlistenOutput.mockClear()
    bridge.unlistenExit.mockClear()
    bridge.invoke.mockReset()
    bridge.invoke
      .mockResolvedValueOnce({ sessionId: START.sessionId })
      .mockRejectedValueOnce(new Error("attach failed"))
    bridge.listen
      .mockResolvedValueOnce(bridge.unlistenOutput)
      .mockResolvedValueOnce(bridge.unlistenExit)

    // Act
    const start = startCodexTerminal(START, handlers())

    // Assert
    await expect(start).rejects.toThrow("attach failed")
    expect(bridge.invoke).toHaveBeenNthCalledWith(3, "codex_terminal_stop", {
      request: { sessionId: START.sessionId },
    })
    expect(bridge.unlistenOutput).toHaveBeenCalledOnce()
    expect(bridge.unlistenExit).toHaveBeenCalledOnce()
  })

  it("writes_terminal_input_in_order_as_utf8_bytes", async () => {
    // Arrange
    bridge.listen.mockReset()
    bridge.invoke.mockReset()
    bridge.invoke.mockResolvedValue({ sessionId: START.sessionId })
    bridge.listen
      .mockResolvedValueOnce(bridge.unlistenOutput)
      .mockResolvedValueOnce(bridge.unlistenExit)
    const session = await startCodexTerminal(START, handlers())

    // Act
    await Promise.all([session.write("a"), session.write("ไทย")])
    await session.resize(30, 100)
    await session.stop()

    // Assert
    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "codex_terminal_start", { request: START })
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "codex_terminal_attach", {
      request: { sessionId: START.sessionId },
    })
    expect(bridge.invoke).toHaveBeenNthCalledWith(3, "codex_terminal_write", {
      request: { sessionId: START.sessionId, data: [97] },
    })
    expect(bridge.invoke).toHaveBeenNthCalledWith(4, "codex_terminal_write", {
      request: {
        sessionId: START.sessionId,
        data: Array.from(new TextEncoder().encode("ไทย")),
      },
    })
    expect(bridge.invoke).toHaveBeenNthCalledWith(5, "codex_terminal_resize", {
      request: { sessionId: START.sessionId, rows: 30, cols: 100 },
    })
    expect(bridge.invoke).toHaveBeenNthCalledWith(6, "codex_terminal_stop", {
      request: { sessionId: START.sessionId },
    })
  })

  it("forwards_the_review_snapshot_unchanged_in_a_context_update", async () => {
    // Arrange
    bridge.listen.mockReset()
    bridge.invoke.mockReset()
    bridge.invoke.mockResolvedValue(null)
    bridge.listen
      .mockResolvedValueOnce(bridge.unlistenOutput)
      .mockResolvedValueOnce(bridge.unlistenExit)
    const session = await startCodexTerminal(START, handlers())
    const review: ReviewSnapshot = {
      queueMode: "foundations",
      selection: { path: "src/app.ts", startLine: 10, endLine: 14 },
      files: [{ path: "src/app.ts", status: "modified", reviewed: false, suggestedNext: true }],
      drafts: [
        { path: "src/app.ts", side: "RIGHT", startLine: 12, endLine: 12, body: "nit: rename" },
      ],
    }
    const context = { ...START.context, selectedFilePath: "src/app.ts", review }

    // Act
    await session.updateContext(context)

    // Assert
    expect(bridge.invoke).toHaveBeenLastCalledWith("codex_terminal_update_context", {
      request: { sessionId: START.sessionId, context },
    })
  })
})
