import { describe, expect, it, vi } from "vitest"

import type { ChatEvent } from "@/entity/aiChat/chatEvent"

import { type AiChatStart, startAiChatSession } from "./chatSession"

type Listener = (event: { payload: unknown }) => void

const tauri = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, listener: Listener) => {
    tauri.listeners.set(eventName, listener)
    return Promise.resolve(() => tauri.listeners.delete(eventName))
  },
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))

const START: AiChatStart = {
  sessionId: "chat-1",
  provider: "claude",
  repositoryPath: "/repo",
  model: "haiku",
  systemPromptAppend: "Use review blocks.",
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

const TEXT_DELTA_LINE = JSON.stringify({
  type: "stream_event",
  api_message_id: "msg_01",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
})

function handlers() {
  return { onEvents: vi.fn<(events: ChatEvent[]) => void>(), onExit: vi.fn() }
}

function emit(eventName: string, payload: unknown): void {
  tauri.listeners.get(eventName)?.({ payload })
}

describe("startAiChatSession", () => {
  it("stops_the_child_when_attach_fails_after_start", async () => {
    // Arrange
    tauri.invoke.mockReset()
    tauri.invoke.mockImplementation((command: string) =>
      command === "ai_chat_attach" ? Promise.reject(new Error("attach failed")) : Promise.resolve()
    )

    // Act
    const start = startAiChatSession(START, handlers())

    // Assert
    await expect(start).rejects.toThrow("attach failed")
    expect(tauri.invoke).toHaveBeenCalledWith("ai_chat_stop", { request: { sessionId: "chat-1" } })
  })

  it("turns_lines_of_this_session_into_chat_events_and_ignores_other_sessions", async () => {
    // Arrange
    tauri.invoke.mockReset()
    tauri.invoke.mockResolvedValue(undefined)
    const chatHandlers = handlers()
    await startAiChatSession(START, chatHandlers)
    const otherSessionId = "chat-2"

    // Act
    emit("ai-chat://line", { sessionId: otherSessionId, sequence: 0, line: TEXT_DELTA_LINE })
    emit("ai-chat://line", { sessionId: START.sessionId, sequence: "bad", line: TEXT_DELTA_LINE })
    emit("ai-chat://line", { sessionId: START.sessionId, sequence: 1, line: TEXT_DELTA_LINE })

    // Assert
    const expected: ChatEvent[] = [{ kind: "assistant_text_delta", partId: "msg_01:0", text: "Hi" }]
    expect(chatHandlers.onEvents.mock.calls).toEqual([[expected]])
  })

  it("sends_messages_in_order_through_the_send_command", async () => {
    // Arrange
    tauri.invoke.mockReset()
    tauri.invoke.mockResolvedValue(undefined)
    const session = await startAiChatSession(START, handlers())
    const firstMessage = "What changed?"
    const secondMessage = "And why?"

    // Act
    await Promise.all([session.send(firstMessage), session.send(secondMessage)])

    // Assert
    const sentTexts = tauri.invoke.mock.calls
      .filter(([command]) => command === "ai_chat_send")
      .map(([, args]) => (args as { request: { text: string } }).request.text)
    expect(sentTexts).toEqual([firstMessage, secondMessage])
  })

  it("refuses_a_provider_without_a_chat_adapter_before_anything_starts", async () => {
    // Arrange
    tauri.invoke.mockReset()
    tauri.listeners.clear()
    const codexStart: AiChatStart = { ...START, provider: "codex" }

    // Act
    const start = startAiChatSession(codexStart, handlers())

    // Assert
    await expect(start).rejects.toThrow("There is no chat for codex yet.")
    expect(tauri.invoke).not.toHaveBeenCalled()
  })
})
