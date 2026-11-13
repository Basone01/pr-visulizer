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
import type { ToolApprovalDecision } from "@/entity/aiChat/toolApproval"
import {
  type SelectableAiProviderId,
  TERMINAL_PROVIDERS,
  isResolvedModel,
  modelDisplayName,
  modelNameForResolvedId,
  offersChat,
} from "@/entity/aiReviewSettings"

import {
  type AiChatSession,
  type AiSessionContext,
  startAiChatSession,
  stopAiChatSession,
} from "@/service/aiChat/chatSession"
import {
  openAnswerFile,
  showAnswerWindow,
  subscribeAnswerReports,
} from "@/service/terminal/answerWindow"

// The lifecycle keeps the same promises as CodexTerminal.tsx (start gate, provider reset,
// PR change ends the session, debounced context, Stop reads "Stopped."). That component mixes
// the same logic with xterm and is not shared yet, so a change to one belongs in both.
// The one intended difference is the model: the terminal resets on a model change, the chat
// switches the running session and keeps its conversation.

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
  // Rejects when the app did not apply the answer. The card's state still comes from events.
  answerApproval: (requestId: string, decision: ToolApprovalDecision) => Promise<void>
  reopenAnswer: () => void
  openFile: (path: string, line: number | undefined) => Promise<void>
}

// What the CLI calls its own default model in a set_model request (measured 2.1.323).
const CLI_DEFAULT_MODEL_ALIAS = "default"
// The error_code the CLI gives for a model it does not know (measured 2.1.323).
const MODEL_NOT_FOUND_CODE = "not_found"

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
  // A provider change never launches: it drops back to idle in every state.
  // Resetting during render (not in an effect) means the start effect never sees
  // the old launchKey paired with the new provider, so nothing starts even briefly.
  // A model change does not reset: a running chat switches model and keeps its conversation.
  const [launchProvider, setLaunchProvider] = useState(provider)
  if (launchProvider !== provider) {
    setLaunchProvider(provider)
    setLaunchKey(0)
  }

  // The model the next Start launches with, read at start time.
  const modelRef = useRef(model)
  modelRef.current = model
  // The model the CLI says the running session is on ("claude-haiku-5-5"), null until it says.
  // Only the CLI sets it, never a request, so a refused change cannot make it wrong.
  const runningModelRef = useRef<string | null>(null)
  // Model changes sent and not answered yet, by request id, with the model the reviewer chose.
  const pendingModelChangesRef = useRef(new Map<string, string | null>())
  // The running session's event sink, so a refused model change outside the start effect
  // reaches the transcript through the same path.
  const applyModelEventsRef = useRef<(events: ReadonlyArray<ChatEvent>) => void>(() => {})

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
    const launchModel = modelRef.current
    runningModelRef.current = null
    pendingModelChangesRef.current.clear()
    applyModelEventsRef.current = (events) => applyEvents(events)
    let active = true
    let exited = false
    let startRequested = false
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
      if (!active) return

      const transcriptEvents = events.flatMap((event): ChatEvent[] => {
        if (event.kind === "model_change_answered") return settleModelChange(event)
        if (event.kind === "model_reported") runningModelRef.current = event.resolvedModel
        return [event]
      })
      setTranscript((current) => applyChatEvents(current, transcriptEvents))
    }

    // Only a reply to one of this session's own requests becomes a notice, so the chat says a
    // model changed only when the provider confirmed it.
    function settleModelChange(
      answer: Extract<ChatEvent, { kind: "model_change_answered" }>
    ): ChatEvent[] {
      const pending = pendingModelChangesRef.current
      if (!pending.has(answer.requestId)) return []

      const chosenModel = pending.get(answer.requestId) ?? null
      pending.delete(answer.requestId)
      if (answer.resolvedModel !== null) runningModelRef.current = answer.resolvedModel
      const modelName = modelDisplayName(provider, chosenModel)
      if (answer.accepted) return [{ kind: "model_changed", modelName }]

      return [
        {
          kind: "model_change_refused",
          modelName,
          previousModelName: runningModelName(),
          reason: answer.error ?? "the CLI refused it",
          // A model that does not exist will not start either, so the notice promises nothing.
          staysSelected: answer.errorCode !== MODEL_NOT_FOUND_CODE,
        },
      ]
    }

    async function startSession(): Promise<void> {
      const systemPromptAppend = await loadSystemPromptRef.current()
      if (!active) return

      startRequested = true
      const startedSession = await startAiChatSession(
        {
          sessionId,
          provider,
          repositoryPath: linkedRepositoryPath,
          model: launchModel,
          systemPromptAppend,
          context: contextRef.current,
        },
        {
          onEvents: applyEvents,
          onExit(exit) {
            if (!active || activeSessionIdRef.current !== exit.sessionId) return

            exited = true
            pendingModelChangesRef.current.clear()
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
      // A model picked while the session was starting missed the model effect, so catch up now.
      // Awaited, so its line reaches the CLI before the first turn and that turn uses it.
      if (modelRef.current !== launchModel) {
        await switchSessionModel(startedSession, modelRef.current)
        if (!active || exited) return
      }
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
      pendingModelChangesRef.current.clear()
      answerUnlisten?.()
      if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null
      onSessionEnded(sessionId)
      if (sessionRef.current === session) sessionRef.current = null
      // After an exit the native side has already dropped the session, so a stop would only reject.
      if (session) void (exited ? session.dispose() : stopAndDispose(session))
      // A start still in flight (a command that never settles) is stopped by its id, so a
      // cancelled launch leaves no process behind. A late session object is disposed above.
      if (session === null && startRequested && !exited) {
        void stopAiChatSession(sessionId).catch(() => undefined)
      }
    }
    // initialPrompt and context are read through refs on purpose, see contextRef above.
  }, [label, launchKey, onSessionEnded, onSessionStarted, provider, repositoryPath, prIdentity])

  // A model change while a chat runs switches the running session, its conversation stays.
  // The CLI accepts it even mid-turn, and the next turn runs on the new model (measured 2.1.323).
  // With no session, the new model only changes what the next Start launches.
  useEffect(() => {
    const session = sessionRef.current
    if (session !== null) void switchSessionModel(session, model)
  }, [model])

  // Resolves once the command settled, a failure is turned into a notice and never rejects.
  async function switchSessionModel(
    session: AiChatSession,
    nextModel: string | null
  ): Promise<void> {
    if (isHeadingToModel(nextModel)) return

    const requestId = createSessionId()
    // Registered before the call: the CLI's reply can arrive before the invoke settles.
    pendingModelChangesRef.current.set(requestId, nextModel)
    try {
      await session.setModel(requestId, nextModel ?? CLI_DEFAULT_MODEL_ALIAS)
    } catch (error) {
      // Already dropped means the session ended first, so there is nothing left to tell.
      if (!pendingModelChangesRef.current.delete(requestId)) return

      applyModelEventsRef.current([
        {
          kind: "model_change_refused",
          modelName: modelDisplayName(provider, nextModel),
          previousModelName: runningModelName(),
          reason: errorText(error),
          staysSelected: true,
        },
      ])
    }
  }

  // Whether the chat already runs this model, or will once the newest request is answered.
  // A pick back to the running model while another request is pending still has to be sent.
  function isHeadingToModel(nextModel: string | null): boolean {
    const pendingModels = [...pendingModelChangesRef.current.values()]
    if (pendingModels.length > 0) return pendingModels.at(-1) === nextModel

    const runningModel = runningModelRef.current
    // The CLI default has no alias to compare with, so picking it is always sent.
    if (runningModel === null || nextModel === null) return false

    return isResolvedModel(provider, runningModel, nextModel)
  }

  function runningModelName(): string | null {
    const runningModel = runningModelRef.current
    return runningModel === null ? null : modelNameForResolvedId(provider, runningModel)
  }

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
    // Still starting: cancel the launch, which drops back to idle and stops what was started.
    if (sessionRef.current === null && status === "starting") {
      setLaunchKey(0)
      return
    }

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

  // Stable, so memoized transcript entries do not re-render on every streamed delta.
  const answerApproval = useCallback(
    async (requestId: string, decision: ToolApprovalDecision): Promise<void> => {
      const session = sessionRef.current
      if (session === null) throw new Error("The chat session has ended.")

      await session.answerApproval(requestId, decision)
    },
    []
  )

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
    answerApproval,
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
