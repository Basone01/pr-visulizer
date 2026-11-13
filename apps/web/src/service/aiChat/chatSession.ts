import { z } from "zod"

import type { ChatEvent } from "@/entity/aiChat/chatEvent"
import { type ToolApprovalDecision, toolApprovalEventSchema } from "@/entity/aiChat/toolApproval"
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
  // The caller makes requestId and registers it before calling: the reply can reach the line
  // stream before this promise settles. model is the alias, or "default" for the CLI default.
  setModel(requestId: string, model: string): Promise<void>
  // Sends only the decision. The app runs the input it stored, never one from the webview.
  answerApproval(requestId: string, decision: ToolApprovalDecision): Promise<void>
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

async function createChannel(onMessage: (message: unknown) => void): Promise<object> {
  tauriCore ??= import("@tauri-apps/api/core")
  const { Channel } = await tauriCore
  return new Channel<unknown>(onMessage)
}

// Stops a session by id, for a start that is still in flight and has no session object yet.
export function stopAiChatSession(sessionId: string): Promise<void> {
  return invoke("ai_chat_stop", { request: { sessionId } })
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

  function unlistenAll(): void {
    lineUnlisten()
    exitUnlisten()
  }

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
    unlistenAll()
    throw error
  }

  // Before the first turn, so no request of that turn arrives with nobody watching.
  await watchApprovals()

  // Approvals travel on a channel, not an event: any webview that listens can read an event,
  // and the answer window renders agent-written HTML (CONTRACT.md §6.7).
  async function watchApprovals(): Promise<void> {
    try {
      const onEvent = await createChannel(showApproval)
      await invoke("ai_chat_watch_approvals", { request: { sessionId }, onEvent })
    } catch {
      // The app denies every request that has no watcher, so the chat says so instead of failing.
      handlers.onEvents([{ kind: "approvals_unavailable" }])
    }
  }

  function showApproval(message: unknown): void {
    if (disposed) return

    const approval = toolApprovalEventSchema.safeParse(message)
    if (!approval.success) {
      // Never shown as a card: a request the app cannot vouch for must not be answerable.
      console.warn("Dropped an approval message that did not parse", approval.error)
      return
    }
    // The channel is already this session's own, the id check stays as a second guard.
    if (approval.data.sessionId !== sessionId) return

    const { sessionId: _session, ...toolApproval } = approval.data
    handlers.onEvents([{ kind: "tool_approval_changed", approval: toolApproval }])
  }

  async function dispose(): Promise<void> {
    if (disposed) return

    disposed = true
    unlistenAll()
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
    setModel(requestId, model) {
      return invoke("ai_chat_set_model", { request: { sessionId, requestId, model } })
    },
    answerApproval(requestId, decision) {
      return invoke("ai_chat_answer_approval", { request: { sessionId, requestId, decision } })
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
