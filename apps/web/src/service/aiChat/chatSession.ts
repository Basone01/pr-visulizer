import { z } from "zod"

import type { ChatEvent } from "@/entity/aiChat/chatEvent"
import type { SelectableAiProviderId } from "@/entity/aiReviewSettings"

import type { CodexTerminalContext } from "@/service/terminal/codexTerminal"

import { parseClaudeStreamLine } from "./claudeStreamEvents"

const chatLineSchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  line: z.string(),
})

const chatExitSchema = z.object({
  sessionId: z.string().min(1),
  code: z.number().int().nullable(),
  error: z.string().nullable(),
})

type AiChatExit = z.infer<typeof chatExitSchema>

// The terminal and the chat share one PR context shape, which the native side stores per session.
export type AiSessionContext = CodexTerminalContext

// Each provider's stdout dialect has its own adapter, so nothing past this file sees a wire line.
// Which providers offer a chat is decided by TERMINAL_PROVIDERS, this only maps the dialect.
const LINE_ADAPTERS: Partial<Record<SelectableAiProviderId, (line: string) => ChatEvent[]>> = {
  claude: parseClaudeStreamLine,
}

export type AiChatStart = {
  sessionId: string
  provider: SelectableAiProviderId
  repositoryPath: string
  model: string | null
  // Appended to the CLI's own system prompt. Empty means the flag is left out.
  systemPromptAppend: string
  context: AiSessionContext
}

export type AiChatSession = {
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  updateContext(context: AiSessionContext): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
}

// Imported once and shared. A send and a context push often start together, and Vitest 3.2
// resolves a second in-flight import() of a vi.mock'ed module to the real one.
let tauriCore: Promise<typeof import("@tauri-apps/api/core")> | null = null

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  tauriCore ??= import("@tauri-apps/api/core")
  const { invoke: tauriInvoke } = await tauriCore
  return tauriInvoke<T>(command, args)
}

// This is the only webview-facing chat protocol. Event payloads are parsed and filtered by session
// before the chat sees them, and the native side builds every stdin line from send/interrupt.
export async function startAiChatSession(
  input: AiChatStart,
  handlers: {
    onEvents: (events: ChatEvent[]) => void
    onExit: (exit: AiChatExit) => void
  }
): Promise<AiChatSession> {
  const toChatEvents = LINE_ADAPTERS[input.provider]
  if (toChatEvents === undefined) throw new Error(`There is no chat for ${input.provider} yet.`)

  const { listen } = await import("@tauri-apps/api/event")
  const sessionId = input.sessionId
  let disposed = false
  let sendQueue = Promise.resolve()
  let contextUpdateQueue = Promise.resolve()
  let started = false
  let lineUnlisten = () => {}
  let exitUnlisten = () => {}

  try {
    lineUnlisten = await listen("ai-chat://line", (event: { payload: unknown }) => {
      const line = chatLineSchema.safeParse(event.payload)
      if (!line.success || line.data.sessionId !== sessionId) return

      const events = toChatEvents(line.data.line)
      if (events.length > 0) handlers.onEvents(events)
    })
    exitUnlisten = await listen("ai-chat://exit", (event: { payload: unknown }) => {
      const exit = chatExitSchema.safeParse(event.payload)
      if (exit.success && exit.data.sessionId === sessionId) handlers.onExit(exit.data)
    })
    await invoke("ai_chat_start", { request: input })
    started = true
    await invoke("ai_chat_attach", { request: { sessionId } })
  } catch (error) {
    if (started) {
      await invoke("ai_chat_stop", { request: { sessionId } }).catch(() => undefined)
    }
    lineUnlisten()
    exitUnlisten()
    throw error
  }

  async function dispose(): Promise<void> {
    if (disposed) return

    disposed = true
    lineUnlisten()
    exitUnlisten()
  }

  return {
    send(text) {
      const send = async (): Promise<void> => {
        await invoke("ai_chat_send", { request: { sessionId, text } })
      }
      const queuedSend = sendQueue.catch(() => undefined).then(send)
      sendQueue = queuedSend
      return queuedSend
    },
    interrupt() {
      return invoke("ai_chat_interrupt", { request: { sessionId } })
    },
    // The answer window and the MCP tools read context by sessionId, whichever surface started it.
    updateContext(context) {
      const update = async (): Promise<void> => {
        await invoke("codex_terminal_update_context", { request: { sessionId, context } })
      }
      const queuedUpdate = contextUpdateQueue.catch(() => undefined).then(update)
      contextUpdateQueue = queuedUpdate
      return queuedUpdate
    },
    stop() {
      return invoke("ai_chat_stop", { request: { sessionId } })
    },
    dispose,
  }
}
