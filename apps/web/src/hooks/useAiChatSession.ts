import type { AnswerReport } from "@pr-visulizer/shared"
import { useCallback, useEffect, useRef, useState } from "react"

import { env } from "@/config/env"

import { errorText } from "@/utils/errors/errorText"

import type { ChatEvent, RenderedAnswer } from "@/entity/aiChat/chatEvent"
import {
  type ChatTranscript,
  EMPTY_CHAT_TRANSCRIPT,
  applyChatEvents,
} from "@/entity/aiChat/chatTranscript"
import {
  type SelectableAiProviderId,
  TERMINAL_PROVIDERS,
  offersChat,
} from "@/entity/aiReviewSettings"

import {
  type AiChatSession,
  type AiSessionContext,
  startAiChatSession,
} from "@/service/aiChat/chatSession"
import {
  openAnswerFile,
  showAnswerWindow,
  subscribeAnswerReports,
} from "@/service/terminal/answerWindow"

// The lifecycle keeps the same promises as CodexTerminal.tsx (start gate, provider/model reset,
// PR change ends the session, debounced context, Stop reads "Stopped."). That component mixes
// the same logic with xterm and is not shared yet, so a change to one belongs in both.

export type AiChatStatus = "idle" | "starting" | "running" | "stopped" | "error"

// not_ready: no session, a turn is still running, or the text is empty.
type AiChatSendResult = "sent" | "not_ready" | "too_long"

type UseAiChatSessionInput = {
  provider: SelectableAiProviderId
  repositoryPath: string | null
  // Sent as the first user turn right after the session starts.
  initialPrompt: string
  model: string | null
  // Another PR (or another base/head) ends the session.
  prIdentity: string
  context: AiSessionContext
  onSessionStarted: (sessionId: string) => void
  onSessionEnded: (sessionId: string) => void
  // Injected so this hook never imports a component module (the review UI prompt lives with it).
  loadSystemPrompt: () => Promise<string>
}

type AiChatSessionState = {
  status: AiChatStatus
  message: string | null
  transcript: ChatTranscript
  hasAnswer: boolean
  // Start and Restart both launch a fresh session.
  launch: () => void
  stop: () => void
  // Anything but "sent" means nothing left, so the composer keeps its text.
  // onUnsent hands the text back when the native side rejects a send that already left.
  send: (text: string, onUnsent: (text: string) => void) => AiChatSendResult
  interrupt: () => void
  reopenAnswer: () => void
  openFile: (path: string, line: number | undefined) => Promise<void>
}

// Draft bodies save on every keystroke, so context changes are coalesced before they cross IPC.
const CONTEXT_PUSH_DEBOUNCE_MS = 150

// ai_chat_send rejects anything larger (CONTRACT.md §1), so the limit is checked before sending.
export const MAX_MESSAGE_BYTES = 256 * 1024

function createSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ai-chat-${Date.now()}-${Math.random()}`
}

export function useAiChatSession({
  provider,
  repositoryPath,
  initialPrompt,
  model,
  prIdentity,
  context,
  onSessionStarted,
  onSessionEnded,
  loadSystemPrompt,
}: UseAiChatSessionInput): AiChatSessionState {
  const label = TERMINAL_PROVIDERS[provider].label
  const sessionRef = useRef<AiChatSession | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const stopRequestedRef = useRef(false)
  const [status, setStatus] = useState<AiChatStatus>("idle")
  const [message, setMessage] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<ChatTranscript>(EMPTY_CHAT_TRANSCRIPT)
  const [hasAnswer, setHasAnswer] = useState(false)
  // 0 means the reviewer has not pressed Start yet, Start and Restart both bump it.
  const [launchKey, setLaunchKey] = useState(0)
  // A provider or model change never launches: it drops back to idle in every state.
  // Resetting during render (not in an effect) means the start effect never sees
  // the old launchKey paired with the new provider, so nothing starts even briefly.
  const [launchTarget, setLaunchTarget] = useState({ provider, model })
  if (launchTarget.provider !== provider || launchTarget.model !== model) {
    setLaunchTarget({ provider, model })
    setLaunchKey(0)
  }

  // Read at start time only: a new selected file must not restart the session.
  const contextRef = useRef(context)
  contextRef.current = context
  const initialPromptRef = useRef(initialPrompt)
  initialPromptRef.current = initialPrompt
  const loadSystemPromptRef = useRef(loadSystemPrompt)
  loadSystemPromptRef.current = loadSystemPrompt

  function showError(error: unknown): void {
    setStatus("error")
    setMessage(errorText(error))
  }

  useEffect(() => {
    setHasAnswer(false)
    if (!env.tauriMode) {
      setStatus("error")
      setMessage(`The ${label} chat is available in the desktop app.`)
      return
    }
    if (repositoryPath === null) {
      setStatus("error")
      setMessage(`Link this repository before starting ${label}.`)
      return
    }
    if (!offersChat(provider)) {
      setStatus("error")
      setMessage(`The chat is not available for ${label}. Use the terminal instead.`)
      return
    }
    if (launchKey === 0) {
      setStatus("idle")
      setMessage(`Press Start to chat with ${label}.`)
      return
    }

    const linkedRepositoryPath = repositoryPath
    let active = true
    let exited = false
    let session: AiChatSession | null = null
    const sessionId = createSessionId()
    activeSessionIdRef.current = sessionId
    stopRequestedRef.current = false
    setTranscript(EMPTY_CHAT_TRANSCRIPT)
    setStatus("starting")
    setMessage(null)

    let answerUnlisten: (() => void) | null = null
    // In the chat a rendered answer shows inline. "Open answer" stays the way to pop the latest
    // one out into the window.
    void subscribeAnswerReports(sessionId, (report) => {
      if (!active) return

      setHasAnswer(true)
      applyEvents([{ kind: "answer_rendered", answer: toRenderedAnswer(report) }])
    })
      .then((unlisten) => {
        // Cleanup may already have run (StrictMode double-run), so release a late listener now.
        if (active) answerUnlisten = unlisten
        else unlisten()
      })
      // Without the listener only the reopen button is missing, the chat itself still works.
      .catch(() => undefined)

    function applyEvents(events: ReadonlyArray<ChatEvent>): void {
      if (active) setTranscript((current) => applyChatEvents(current, events))
    }

    async function startSession(): Promise<void> {
      const systemPromptAppend = await loadSystemPromptRef.current()
      if (!active) return

      const startedSession = await startAiChatSession(
        {
          sessionId,
          provider,
          repositoryPath: linkedRepositoryPath,
          model,
          systemPromptAppend,
          context: contextRef.current,
        },
        {
          onEvents: applyEvents,
          onExit(exit) {
            if (!active || activeSessionIdRef.current !== exit.sessionId) return

            exited = true
            applyEvents([{ kind: "session_ended" }])
            sessionRef.current = null
            onSessionEnded(sessionId)
            setStatus("stopped")
            // The native report for our own Stop is a kill signal, which reads like a crash.
            const exitReport =
              exit.error ?? `${label} exited${exit.code === null ? "" : ` (${exit.code})`}.`
            setMessage(stopRequestedRef.current ? "Stopped." : exitReport)
          },
        }
      )
      if (!active || exited) {
        void (exited ? startedSession.dispose() : stopAndDispose(startedSession))
        return
      }

      session = startedSession
      sessionRef.current = startedSession
      onSessionStarted(sessionId)
      void startedSession.updateContext(contextRef.current).catch((error: unknown) => {
        if (active) showError(error)
      })
      setStatus("running")
      applyEvents([{ kind: "pr_context_sent" }])
      await startedSession.send(initialPromptRef.current)
    }

    void startSession().catch((error: unknown) => {
      // A send that fails because the process already exited (or was stopped) adds nothing,
      // and showing it would replace the exit reason, such as "Not logged in".
      const isAfterExit = exited || stopRequestedRef.current
      if (active && !isAfterExit) showError(error)
    })

    return () => {
      active = false
      answerUnlisten?.()
      if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null
      onSessionEnded(sessionId)
      if (sessionRef.current === session) sessionRef.current = null
      // After an exit the native side has already dropped the session, so a stop would only reject.
      if (session) void (exited ? session.dispose() : stopAndDispose(session))
    }
    // initialPrompt and context are read through refs on purpose, see contextRef above.
  }, [
    label,
    launchKey,
    model,
    onSessionEnded,
    onSessionStarted,
    provider,
    repositoryPath,
    prIdentity,
  ])

  // Only changes are debounced. The first push after Start happens in the start path above,
  // straight after the session comes up, so it is never delayed.
  useEffect(() => {
    if (sessionRef.current === null) return

    const timer = window.setTimeout(() => {
      const session = sessionRef.current
      if (session === null) return

      void session.updateContext(context).catch(showError)
    }, CONTEXT_PUSH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [context])

  function launch(): void {
    setLaunchKey((key) => key + 1)
  }

  function stop(): void {
    stopRequestedRef.current = true
    void sessionRef.current?.stop().catch((error: unknown) => {
      stopRequestedRef.current = false
      showError(error)
    })
  }

  function send(text: string, onUnsent: (text: string) => void): AiChatSendResult {
    const session = sessionRef.current
    const trimmedText = text.trim()
    const canSend = status === "running" && transcript.turn === "idle"
    if (session === null || !canSend || trimmedText === "") return "not_ready"

    const isTooLong = new TextEncoder().encode(trimmedText).byteLength > MAX_MESSAGE_BYTES
    if (isTooLong) return "too_long"

    setTranscript((current) =>
      applyChatEvents(current, [{ kind: "user_message_sent", text: trimmedText }])
    )
    // The process is still alive after a rejected send, so only this turn fails, not the session.
    void session.send(trimmedText).catch((error: unknown) => {
      const message = `The message was not sent: ${errorText(error)}`
      setTranscript((current) =>
        applyChatEvents(current, [{ kind: "turn_ended", outcome: "failed", message }])
      )
      onUnsent(trimmedText)
    })
    return "sent"
  }

  function interrupt(): void {
    void sessionRef.current?.interrupt().catch(showError)
  }

  function reopenAnswer(): void {
    const sessionId = activeSessionIdRef.current
    if (sessionId === null) return

    void showAnswerWindow(sessionId).catch(showError)
  }

  // Stable, so memoized transcript entries do not re-render on every streamed delta.
  const openFile = useCallback(async (path: string, line: number | undefined): Promise<void> => {
    const sessionId = activeSessionIdRef.current
    if (sessionId === null) throw new Error("Start the chat to open files from it.")

    await openAnswerFile(sessionId, path, line)
  }, [])

  return {
    status,
    message,
    transcript,
    hasAnswer,
    launch,
    stop,
    send,
    interrupt,
    reopenAnswer,
    openFile,
  }
}

function stopAndDispose(session: AiChatSession): Promise<void> {
  // A session that is already gone rejects the stop, and there is nothing left to stop.
  return session
    .stop()
    .catch(() => undefined)
    .finally(session.dispose)
}

function toRenderedAnswer(report: AnswerReport): RenderedAnswer {
  return {
    title: report.title,
    markdown: report.markdown,
    fileReferences: report.fileRefs.map((fileRef) => ({
      path: fileRef.path,
      line: fileRef.line ?? null,
      label: fileRef.label ?? null,
    })),
  }
}
