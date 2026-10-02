import type {
  AiChatMessage,
  AiChatThread,
  AiFinding,
  AiReviewRun,
  AiReviewTarget,
  ChatContextReference,
  ChatScope,
  ObservedCodexSafeProfileProvenance,
} from "@pr-visulizer/shared"
import { aiFindingSchema } from "@pr-visulizer/shared"
import { useEffect, useMemo, useRef, useState } from "react"

import { validateFindingAnchors } from "@/utils/aiReview/findingValidation"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  createAiChatStorage,
  rebuildChatHistory,
  selectReloadedChatThread,
} from "@/service/aiReview/chatStorage"
import {
  type CodexReviewContext,
  createCodexSafeProfileScopedChatContext,
} from "@/service/aiReview/codexReviewContext"
import { createAiReviewRunStorage } from "@/service/aiReview/runStorage"
import { loadAiReviewSettings } from "@/service/aiReview/settingsStorage"
import {
  type TauriAiChatLifecycle,
  getTauriAiReviewClient,
} from "@/service/aiReview/tauriAiReviewClient"

import { MarkdownContent } from "@/components/markdown/MarkdownContent"

import styles from "./AiReviewPanel.module.css"

type SelectionScope = Extract<ChatContextReference, { scope: "selection" }>

type AiChatPanelProps = {
  target: AiReviewTarget
  storage: KeyValueStore
  baseSha: string
  headSha: string
  currentFilePath: string | null
  currentSelection: SelectionScope | null
  // A future broker-backed chat lifecycle supplies this only after it has calculated the full
  // current disclosure/security fingerprint. Null means stored history is never reused as a
  // runtime provider session.
  contextSecurityFingerprint: string | null
  observedProvenance?: ObservedCodexSafeProfileProvenance | null
  currentProvider: "claude" | "codex" | null
  createCodexSafeProfileChatContext?: (input: {
    profile: "quick" | "balanced" | "thorough"
    selectedModel: string | null
    observedProvenance: ObservedCodexSafeProfileProvenance
  }) => Promise<{ context: CodexReviewContext }>
  startCodexSafeProfileChat?: (
    input: Parameters<ReturnType<typeof getTauriAiReviewClient>["startCodexSafeProfileChat"]>[0]
  ) => TauriAiChatLifecycle
}

type CandidateValidation = Map<string, string | null>

type FindingReference = {
  runId: string
  baseSha: string
  headSha: string
  contextSecurityFingerprint: string
  finding: AiFinding
}

type ChatIdentity = {
  target: AiReviewTarget
  baseSha: string
  headSha: string
  provider: "claude" | "codex" | null
  contextSecurityFingerprint: string | null
  observedProvenanceFingerprint: string | null
}

function chatIdentityKey(identity: ChatIdentity): string {
  return [
    identity.target.owner,
    identity.target.repo,
    identity.target.number,
    identity.baseSha,
    identity.headSha,
    identity.provider ?? "no-provider",
    identity.contextSecurityFingerprint ?? "no-security-fingerprint",
    identity.observedProvenanceFingerprint ?? "no-observed-provenance",
  ].join("\u0000")
}

function describeScope(context: ChatContextReference): string {
  if (context.scope === "whole-pr") return "Whole PR"
  if (context.scope === "file") return `File: ${context.path}`
  if (context.scope === "finding") return `Finding: ${context.findingId}`

  return `Selection: ${context.path} (${context.side} lines ${context.startLine}–${context.endLine})`
}

function candidateId(threadId: string, messageId: string, findingId: string): string {
  return `${threadId}:${messageId}:${findingId}`
}

function findingReferences(runs: readonly AiReviewRun[]): FindingReference[] {
  return runs.flatMap((run) =>
    run.status === "completed"
      ? run.findings.map((finding) => ({
          runId: run.id,
          baseSha: run.baseSha,
          headSha: run.headSha,
          contextSecurityFingerprint: run.contextSecurityFingerprint,
          finding,
        }))
      : []
  )
}

// Provider-neutral chat presentation. It persists no process/session identifier and has no
// provider invocation path while production adapters remain unavailable. A future broker-backed
// lifecycle can append its schema-valid assistant message here after the same policy checks.
export function AiChatPanel({
  target,
  storage,
  baseSha,
  headSha,
  currentFilePath,
  currentSelection,
  contextSecurityFingerprint,
  observedProvenance = null,
  currentProvider,
  createCodexSafeProfileChatContext,
  startCodexSafeProfileChat,
}: AiChatPanelProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = useState<string | null>(null)
  const [threads, setThreads] = useState<AiChatThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [savedFindingIds, setSavedFindingIds] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<ChatScope>(
    currentSelection ? "selection" : currentFilePath ? "file" : "whole-pr"
  )
  const [selectedFindingId, setSelectedFindingId] = useState<string>("")
  const [candidateValidation, setCandidateValidation] = useState<CandidateValidation>(new Map())
  const [activeContextSecurityFingerprint, setActiveContextSecurityFingerprint] = useState<
    string | null
  >(contextSecurityFingerprint)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [draftMessage, setDraftMessage] = useState("")
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [activity, setActivity] = useState<Array<{ label: string; elapsedMs: number }>>([])
  const [liveElapsedMs, setLiveElapsedMs] = useState(0)
  const [followingLatest, setFollowingLatest] = useState(true)
  const [sendState, setSendState] = useState<"idle" | "sending" | "cancelling">("idle")
  const [sendMessage, setSendMessage] = useState<string | null>(null)
  const activeChatRef = useRef<TauriAiChatLifecycle | null>(null)
  // Explicit chat cancellation rejects its ephemeral model turn without invalidating a newer
  // identity. Identity invalidation still advances the generation below.
  const cancellationRequestedRef = useRef(false)
  const preparationGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const activityStartedAtRef = useRef<number | null>(null)
  const chatIdentity = useMemo(
    () => ({
      target,
      baseSha,
      headSha,
      provider: currentProvider,
      contextSecurityFingerprint,
      observedProvenanceFingerprint: observedProvenance?.provenanceFingerprint ?? null,
    }),
    [baseSha, contextSecurityFingerprint, currentProvider, headSha, observedProvenance, target]
  )
  const chatIdentityKeyValue = chatIdentityKey(chatIdentity)
  // The locally active fingerprint becomes the exact launch-context identity while a parent has
  // not yet projected it. Include it in save latching so a new disclosure context cannot save a
  // candidate validated under the prior one.
  const chatValidationIdentity = `${chatIdentityKeyValue}\u0000${activeContextSecurityFingerprint ?? "no-active-security-fingerprint"}`
  const chatIdentityKeyRef = useRef(chatIdentityKeyValue)
  const chatValidationIdentityRef = useRef(chatValidationIdentity)
  chatIdentityKeyRef.current = chatIdentityKeyValue
  chatValidationIdentityRef.current = chatValidationIdentity

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript || !followingLatest) return

    transcript.scrollTop = transcript.scrollHeight
  }, [activity, followingLatest, messages, pendingMessage])

  useEffect(() => {
    if (sendState === "idle") return

    const timer = window.setInterval(() => {
      setLiveElapsedMs(Date.now() - (activityStartedAtRef.current ?? Date.now()))
    }, 250)
    return () => window.clearInterval(timer)
  }, [sendState])

  function invalidateChatPreparation(message: string | null): void {
    // Generation changes synchronously. Every preparation continuation closes over its own value,
    // so it cannot persist a thread or either turn message after identity invalidation.
    preparationGenerationRef.current += 1
    cancellationRequestedRef.current = false
    const lifecycle = activeChatRef.current
    activeChatRef.current = null
    setSendState("idle")
    setSendMessage(message)
    setPendingMessage(null)
    setActivity([])
    setLiveElapsedMs(0)
    setFollowingLatest(true)
    void lifecycle?.cancel()
  }

  // Visible target-owned state and any preparation are bound to the current target, provider,
  // and disclosure fingerprint. An invalidated preparation may not append a turn.
  useEffect(() => {
    invalidateChatPreparation(null)
    setDraftMessage("")
    setThreads([])
    setMessages([])
    setSavedFindingIds(new Set())
    setSelectedThreadId(null)
    setSelectedFindingId("")
    setAvailableFindings([])
    setCandidateValidation(new Map())
    setActiveContextSecurityFingerprint(contextSecurityFingerprint)
  }, [chatIdentityKeyValue, contextSecurityFingerprint])

  useEffect(() => {
    // StrictMode replays setup → cleanup → setup in development. Restore the live marker during
    // setup so the first replay cleanup cannot permanently invalidate every later chat turn.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invalidateChatPreparation(null)
    }
  }, [])

  useEffect(() => {
    let active = true

    async function load(): Promise<void> {
      setStatus("loading")
      setError(null)
      try {
        const chatStorage = createAiChatStorage(storage)
        const runStorage = createAiReviewRunStorage(storage)
        const [storedThreads, savedFindings] = await Promise.all([
          chatStorage.listThreads(target),
          chatStorage.listSavedFindings(target),
        ])
        if (!active) return

        setThreads(storedThreads)
        setSavedFindingIds(new Set(savedFindings.map((finding) => finding.id)))
        // Identity reset has already invalidated the former in-memory selection. Reloaded
        // target-owned history is local-only and must use a stable permitted thread choice.
        setSelectedThreadId(selectReloadedChatThread(storedThreads, target)?.id ?? null)
        const runs = await runStorage.listRuns(target)
        if (!active) return

        const references = findingReferences(runs)
        setAvailableFindings(references)
        setSelectedFindingId((current) =>
          references.some(({ runId, finding }) => `${runId}:${finding.id}` === current)
            ? current
            : references[0]
              ? `${references[0].runId}:${references[0].finding.id}`
              : ""
        )
        setStatus("ready")
      } catch (loadError) {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setStatus("error")
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [chatIdentityKeyValue, storage])

  const thread = threads.find((storedThread) => storedThread.id === selectedThreadId) ?? null

  useEffect(() => {
    let active = true

    async function loadMessages(): Promise<void> {
      if (!thread) {
        setMessages([])
        return
      }

      try {
        const storedMessages = await createAiChatStorage(storage).listMessages(thread.id)
        if (active) setMessages(storedMessages)
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    }

    void loadMessages()
    return () => {
      active = false
    }
  }, [storage, thread])

  useEffect(() => {
    if (scope === "selection" && currentSelection === null) {
      setScope(currentFilePath ? "file" : "whole-pr")
    }
    if (scope === "file" && currentFilePath === null) setScope("whole-pr")
  }, [currentFilePath, currentSelection, scope])

  // Run findings are kept separately from chat storage so selecting a finding never rewrites
  // immutable one-shot output into a chat record.
  const [availableFindings, setAvailableFindings] = useState<FindingReference[]>([])

  const selectedFinding = availableFindings.find(
    ({ runId, finding }) => `${runId}:${finding.id}` === selectedFindingId
  )
  const attachedContext: ChatContextReference =
    scope === "selection" && currentSelection
      ? currentSelection
      : scope === "file" && currentFilePath
        ? { scope: "file", path: currentFilePath }
        : scope === "finding" && selectedFinding
          ? {
              scope: "finding",
              runId: selectedFinding.runId,
              findingId: selectedFinding.finding.id,
            }
          : { scope: "whole-pr" }

  const history = useMemo(() => {
    if (!thread || contextSecurityFingerprint === null) {
      return {
        sessionCompatibility: null,
        messages: messages.map((message) => ({ message, context: "historical" as const })),
        omittedMessageIds: [],
      }
    }

    return rebuildChatHistory(thread, messages, {
      contextSecurityFingerprint,
      permittedHistoricalMessageIds: [],
    })
  }, [contextSecurityFingerprint, messages, thread])

  useEffect(() => {
    const next = new Map<string, string | null>()
    const currentFingerprint = contextSecurityFingerprint ?? activeContextSecurityFingerprint

    for (const message of messages) {
      if (message.role !== "assistant" || message.findingCandidate === null) continue
      try {
        const candidate = aiFindingSchema.parse(message.findingCandidate)
        const snapshot = message.recordedPatchSnapshot
        if (
          snapshot === null ||
          snapshot.baseSha !== baseSha ||
          snapshot.headSha !== headSha ||
          snapshot.contextSecurityFingerprint !== currentFingerprint ||
          snapshot.contextSecurityFingerprint !== message.contextSecurityFingerprint ||
          JSON.stringify(snapshot.attachedContext) !== JSON.stringify(message.attachedContext)
        ) {
          next.set(
            message.id,
            "The chat response has no exact revision-pinned patch snapshot for the current identity."
          )
          continue
        }
        // Every side-present candidate, including one missing a path, is checked against the
        // immutable assistant-turn snapshot—not a display/current patch read.
        const anchors = validateFindingAnchors([candidate], snapshot.patches)
        next.set(
          message.id,
          anchors.valid ? null : anchors.errors.map((anchor) => anchor.reason).join(" ")
        )
      } catch (validationError) {
        next.set(
          message.id,
          validationError instanceof Error
            ? validationError.message
            : "The finding candidate is not valid."
        )
      }
    }
    setCandidateValidation(next)
  }, [activeContextSecurityFingerprint, baseSha, contextSecurityFingerprint, headSha, messages])

  async function saveFinding(message: AiChatMessage): Promise<void> {
    if (!thread || message.findingCandidate === null) return
    const validation = candidateValidation.get(message.id)
    const validationIdentity = chatValidationIdentity
    if (validation !== null || validationIdentity !== chatValidationIdentityRef.current) return

    try {
      const candidate = aiFindingSchema.parse(message.findingCandidate)
      const saved = await createAiChatStorage(storage).saveFinding(
        {
          id: candidateId(thread.id, message.id, candidate.id),
          threadId: thread.id,
          messageId: message.id,
          finding: candidate,
          savedAt: new Date().toISOString(),
        },
        () => validationIdentity === chatValidationIdentityRef.current
      )
      if (validationIdentity !== chatValidationIdentityRef.current) return
      setSavedFindingIds((current) => new Set(current).add(saved.id))
      setSaveMessage("Saved as a validated advisory finding. It has not been published or drafted.")
    } catch (saveError) {
      setSaveMessage(
        saveError instanceof Error ? saveError.message : "Could not save the chat finding."
      )
    }
  }

  async function sendCodexSafeProfileChat(): Promise<void> {
    if (
      !createCodexSafeProfileChatContext ||
      currentProvider !== "codex" ||
      observedProvenance === null ||
      contextSecurityFingerprint === null ||
      draftMessage.trim() === "" ||
      sendState !== "idle"
    ) {
      return
    }

    const preparationGeneration = preparationGenerationRef.current + 1
    preparationGenerationRef.current = preparationGeneration
    cancellationRequestedRef.current = false
    const isCurrentChatGeneration = () =>
      mountedRef.current &&
      preparationGenerationRef.current === preparationGeneration &&
      chatIdentityKeyRef.current === chatIdentityKeyValue
    const isCurrentPreparation = () =>
      isCurrentChatGeneration() && !cancellationRequestedRef.current
    const message = draftMessage.trim()
    const contextReference = attachedContext
    const findingReference = selectedFinding

    setSendState("sending")
    setPendingMessage(message)
    setActivity([{ label: "Preparing context", elapsedMs: 0 }])
    setLiveElapsedMs(0)
    activityStartedAtRef.current = Date.now()
    setSendMessage("Preparing a fresh, scope-bound Codex chat turn…")
    try {
      const settings = await loadAiReviewSettings(storage)
      if (!isCurrentPreparation()) return
      if (settings.defaultProvider !== "codex") {
        throw new Error("Select the available Codex safe profile before sending chat.")
      }
      const launch = await createCodexSafeProfileChatContext({
        profile: settings.defaultProfile,
        selectedModel: settings.providers.codex.selectedModel,
        observedProvenance:
          observedProvenance ??
          (() => {
            throw new Error("Codex safe-profile provenance receipt is unavailable for chat.")
          })(),
      })
      if (!isCurrentPreparation()) return
      if (
        contextReference.scope === "finding" &&
        (!findingReference ||
          findingReference.baseSha !== launch.context.baseSha ||
          findingReference.headSha !== launch.context.headSha ||
          findingReference.contextSecurityFingerprint !== launch.context.contextSecurityFingerprint)
      ) {
        throw new Error(
          "The selected finding is not validated for the current chat disclosure policy and security fingerprint."
        )
      }

      setActiveContextSecurityFingerprint(launch.context.contextSecurityFingerprint)
      const chatStorage = createAiChatStorage(storage)
      // Do not persist a thread or user message while capability/listener/admission is pending.
      // The ephemeral descriptor is sufficient to build a fresh broker turn and is stored only
      // after this generation still owns the admitted lifecycle.
      const selectedThread = thread ?? {
        id: `codex-chat-${target.number}-${Date.now()}`,
        target,
        baseSha,
        headSha,
        kind: "main" as const,
        focusedContext: null,
        contextSecurityFingerprint: launch.context.contextSecurityFingerprint,
        observedProvenance: launch.context.observedProvenance,
        createdAt: new Date().toISOString(),
      }
      if (!isCurrentPreparation()) return
      const storedMessages = thread ? await chatStorage.listMessages(selectedThread.id) : []
      if (!isCurrentPreparation()) return
      const rebuilt = rebuildChatHistory(selectedThread, storedMessages, {
        contextSecurityFingerprint: launch.context.contextSecurityFingerprint,
        permittedHistoricalMessageIds: [],
      })
      const now = new Date().toISOString()
      const userMessage: AiChatMessage = {
        id: `chat-user-${Date.now()}`,
        threadId: selectedThread.id,
        role: "user",
        content: message,
        attachedContext: contextReference,
        findingCandidate: null,
        recordedPatchSnapshot: null,
        contextSecurityFingerprint: launch.context.contextSecurityFingerprint,
        observedProvenance: launch.context.observedProvenance,
        createdAt: now,
      }
      const scopedChatContext = createCodexSafeProfileScopedChatContext(launch.context, {
        attachedContext: contextReference,
        message: userMessage.content,
        history: rebuilt.messages.map(({ message }) => message),
        finding: contextReference.scope === "finding" ? (findingReference?.finding ?? null) : null,
      })
      const lifecycleStarter =
        startCodexSafeProfileChat ?? getTauriAiReviewClient().startCodexSafeProfileChat
      const lifecycle = lifecycleStarter({
        runId: `codex-chat-${Date.now()}`,
        thread: selectedThread,
        attachedContext: contextReference,
        message: userMessage.content,
        prompt: scopedChatContext.prompt,
        model: launch.context.selectedModel,
        observedProvenance: launch.context.observedProvenance,
        history: rebuilt.messages.map(({ message }) => message),
        isCurrentGeneration: isCurrentPreparation,
        onEvent: (event) => {
          if (isCurrentPreparation()) {
            const label = ("message" in event && event.message.trim()) || event.type
            const elapsedMs = Date.now() - (activityStartedAtRef.current ?? Date.now())
            setActivity((current) =>
              current.at(-1)?.label === label
                ? current
                : [...current.slice(-5), { label, elapsedMs }]
            )
            setSendMessage("Codex is working…")
          }
        },
      })
      setActivity((current) => [
        ...current,
        {
          label: "Starting Codex",
          elapsedMs: Date.now() - (activityStartedAtRef.current ?? Date.now()),
        },
      ])
      if (!isCurrentPreparation()) {
        await lifecycle.cancel()
        return
      }
      activeChatRef.current = lifecycle
      // Pre-admission failures reject both lifecycle promises. This observer handles the terminal
      // rejection when admission fails first, while the awaited admission below returns the send
      // control to its retryable idle state without persisting a local turn.
      void lifecycle.completion.catch(() => undefined)
      // Rust must acknowledge active admission before local disclosure persistence. The same
      // generation guard is rechecked inside each serialized storage mutation.
      await lifecycle.admission
      if (!isCurrentPreparation()) return
      if (thread === null) {
        await chatStorage.createThread(selectedThread, isCurrentPreparation)
        if (!isCurrentPreparation()) return
      }
      await chatStorage.appendMessage(userMessage, isCurrentPreparation)
      if (!isCurrentPreparation()) return
      setThreads((current) =>
        current.some((storedThread) => storedThread.id === selectedThread.id)
          ? current
          : [selectedThread, ...current]
      )
      setSelectedThreadId(selectedThread.id)
      setMessages((current) =>
        current.some((storedMessage) => storedMessage.id === userMessage.id)
          ? current
          : [...current, userMessage]
      )
      setDraftMessage("")
      setPendingMessage(null)
      const output = await lifecycle.completion
      if (!isCurrentPreparation()) return
      setActivity((current) => [
        ...current.slice(-5),
        {
          label: "Validating and saving response",
          elapsedMs: Date.now() - (activityStartedAtRef.current ?? Date.now()),
        },
      ])
      const assistantMessage: AiChatMessage = {
        id: `chat-assistant-${Date.now()}`,
        threadId: selectedThread.id,
        role: "assistant",
        content: output.message,
        attachedContext: contextReference,
        findingCandidate: output.findingCandidate,
        recordedPatchSnapshot: scopedChatContext.patchSnapshot,
        contextSecurityFingerprint: launch.context.contextSecurityFingerprint,
        observedProvenance: launch.context.observedProvenance,
        createdAt: new Date(Date.parse(now) + 1).toISOString(),
      }
      await chatStorage.appendMessage(assistantMessage, isCurrentPreparation)
      if (!isCurrentPreparation()) return
      const refreshedThreads = await chatStorage.listThreads(target)
      if (!isCurrentPreparation()) return
      const refreshedMessages = await chatStorage.listMessages(selectedThread.id)
      if (!isCurrentPreparation()) return
      setThreads(refreshedThreads)
      setSelectedThreadId(selectedThread.id)
      setMessages(refreshedMessages)
      setDraftMessage("")
      setPendingMessage(null)
      setSendMessage("Saved chat turn locally.")
    } catch (sendError) {
      if (isCurrentChatGeneration()) {
        setSendMessage(
          cancellationRequestedRef.current
            ? "Codex safe-profile chat was cancelled. No model response was saved."
            : sendError instanceof Error
              ? sendError.message
              : "Codex chat could not start."
        )
      }
    } finally {
      if (isCurrentChatGeneration()) {
        activeChatRef.current = null
        cancellationRequestedRef.current = false
        setPendingMessage(null)
        setSendState("idle")
      }
    }
  }

  async function cancelCodexSafeProfileChat(): Promise<void> {
    const lifecycle = activeChatRef.current
    if (!lifecycle) {
      // Cancellation before admission has no local turn to retain.
      invalidateChatPreparation(
        "Cancelling Codex safe-profile chat and cleaning up its process tree…"
      )
      return
    }
    // Do not advance the identity generation here. The same admitted chat lifecycle must reject
    // its late model result, then settle its controls before another message can start.
    cancellationRequestedRef.current = true
    setSendState("cancelling")
    setSendMessage("Cancelling Codex safe-profile chat and cleaning up its process tree…")
    await lifecycle.cancel()
  }

  const scopeFindingOptions = availableFindings.map(({ runId, finding }) => ({
    value: `${runId}:${finding.id}`,
    label: `${finding.title} (${finding.path ?? "unanchored"})`,
  }))
  const chatAvailable =
    currentProvider === "codex" &&
    observedProvenance !== null &&
    contextSecurityFingerprint !== null &&
    createCodexSafeProfileChatContext !== undefined
  const unavailableChatMessage =
    currentProvider === "claude"
      ? "Claude CLI is unavailable for chat. Select an available Codex CLI in Review setup."
      : currentProvider === "codex" &&
          observedProvenance !== null &&
          contextSecurityFingerprint === null
        ? "Preparing the current PR context for chat…"
        : currentProvider === "codex"
          ? "Codex CLI is unavailable for chat. Check its capability status in Review setup."
          : "Select an available Codex CLI in Review setup before starting chat."

  return (
    <section className={styles.chat} aria-label="AI chat conversation">
      {!chatAvailable && (
        <p className={styles.warning} role="alert">
          {unavailableChatMessage}
        </p>
      )}

      {status === "loading" && <p className={styles.notice}>Loading local chat history…</p>}
      {status === "error" && (
        <p className={styles.error} role="alert">
          Couldn&apos;t load local chat history: {error}
        </p>
      )}

      <label className={styles.field}>
        Context
        <select
          className={styles.select}
          value={scope}
          onChange={(event) => setScope(event.target.value as ChatScope)}
        >
          <option value="selection" disabled={currentSelection === null}>
            Current selection
          </option>
          <option value="file" disabled={currentFilePath === null}>
            Current file
          </option>
          <option value="finding" disabled={scopeFindingOptions.length === 0}>
            Specific finding
          </option>
          <option value="whole-pr">Whole PR</option>
        </select>
      </label>
      {scope === "finding" && scopeFindingOptions.length > 0 && (
        <label className={styles.field}>
          Finding
          <select
            className={styles.select}
            value={selectedFindingId}
            onChange={(event) => setSelectedFindingId(event.target.value)}
          >
            {scopeFindingOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className={styles.chatScope} role="status">
        Attached: {describeScope(attachedContext)}
      </p>

      {thread !== null ? (
        <>
          <label className={styles.field}>
            Conversation
            <select
              className={styles.select}
              value={thread.id}
              onChange={(event) => setSelectedThreadId(event.target.value)}
            >
              {threads.map((storedThread) => (
                <option key={storedThread.id} value={storedThread.id}>
                  {storedThread.kind === "main" ? "Main PR conversation" : "Focused conversation"}
                </option>
              ))}
            </select>
          </label>

          <div
            className={styles.transcript}
            ref={transcriptRef}
            aria-label="Chat transcript"
            onScroll={(event) => {
              const element = event.currentTarget
              const distanceFromBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight
              setFollowingLatest(distanceFromBottom <= 24)
            }}
          >
            {history.sessionCompatibility === "fresh-required" && (
              <p className={styles.warning} role="status">
                PR context changed. Earlier messages aren&apos;t included.
                {history.omittedMessageIds.length > 0
                  ? ` (${history.omittedMessageIds.length})`
                  : ""}
              </p>
            )}
            {history.messages.length === 0 ? (
              <p className={styles.empty}>No messages yet.</p>
            ) : (
              <ol className={styles.chatMessages} aria-label="AI chat messages">
                {history.messages.map(({ message, context }) => {
                  const savedId =
                    message.findingCandidate === null
                      ? null
                      : candidateId(thread.id, message.id, message.findingCandidate.id)
                  const validation = candidateValidation.get(message.id)
                  const canSave =
                    message.findingCandidate !== null &&
                    validation === null &&
                    savedId !== null &&
                    !savedFindingIds.has(savedId)

                  return (
                    <li className={styles.chatMessage} key={message.id}>
                      <strong>{message.role === "assistant" ? "AI" : "You"}</strong>
                      {message.role === "assistant" ? (
                        <MarkdownContent source={message.content} variant="inline" />
                      ) : (
                        <p>{message.content}</p>
                      )}
                      <p className={styles.meta}>
                        Attached: {describeScope(message.attachedContext)} · {context} context
                      </p>
                      {message.findingCandidate !== null && (
                        <>
                          {validation === undefined ? (
                            <p className={styles.meta}>Validating finding anchor…</p>
                          ) : validation === null ? (
                            <button
                              type="button"
                              className={styles.linkButton}
                              disabled={!canSave}
                              onClick={() => void saveFinding(message)}
                            >
                              {savedId && savedFindingIds.has(savedId)
                                ? "Saved as finding"
                                : "Save as finding"}
                            </button>
                          ) : (
                            <p className={styles.warning}>
                              This finding candidate cannot be saved: {validation}
                            </p>
                          )}
                        </>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
            {pendingMessage !== null && (
              <div className={styles.pendingMessage}>
                <strong>You</strong>
                <p>{pendingMessage}</p>
                <span>Sending…</span>
              </div>
            )}
          </div>
        </>
      ) : null}

      {thread === null && pendingMessage !== null && (
        <div className={styles.pendingMessage}>
          <strong>You</strong>
          <p>{pendingMessage}</p>
          <span>Sending…</span>
        </div>
      )}

      {!followingLatest && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setFollowingLatest(true)
            const transcript = transcriptRef.current
            if (transcript) transcript.scrollTop = transcript.scrollHeight
          }}
        >
          Jump to latest
        </button>
      )}

      {sendState !== "idle" && (
        <div className={styles.activityTail} role="status" aria-label="Chat activity">
          <strong>Working · {(liveElapsedMs / 1000).toFixed(1)}s</strong>
          {activity.map((entry, index) => (
            <span key={`${entry.elapsedMs}-${index}`}>
              {entry.label} · {(entry.elapsedMs / 1000).toFixed(1)}s
            </span>
          ))}
        </div>
      )}

      <label className={styles.field}>
        Message
        <textarea
          className={styles.input}
          value={draftMessage}
          disabled={sendState !== "idle" || !chatAvailable}
          onChange={(event) => setDraftMessage(event.target.value)}
          placeholder="Ask a scoped question about the disclosed PR context."
        />
      </label>
      <button
        type="button"
        className={styles.launch}
        disabled={
          sendState !== "idle" ||
          !chatAvailable ||
          draftMessage.trim() === "" ||
          !createCodexSafeProfileChatContext
        }
        onClick={() => void sendCodexSafeProfileChat()}
      >
        {sendState === "cancelling"
          ? "Cancelling…"
          : sendState === "sending"
            ? "Sending…"
            : "Send message"}
      </button>
      {sendState === "sending" && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => void cancelCodexSafeProfileChat()}
        >
          Cancel chat
        </button>
      )}
      <details className={styles.capabilityDetails}>
        <summary>Chat details</summary>
        <p className={styles.notice}>
          Codex can read only the context you attach. It cannot run commands, use tools, search the
          web, or edit files.
        </p>
      </details>
      {sendMessage && (
        <p className={styles.notice} role="status">
          {sendMessage}
        </p>
      )}
      {saveMessage && (
        <p className={styles.notice} role="status">
          {saveMessage}
        </p>
      )}
    </section>
  )
}
