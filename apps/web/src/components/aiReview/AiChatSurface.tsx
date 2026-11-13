import {
  type RefObject,
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { errorText } from "@/utils/errors/errorText"
import { githubPrUrl } from "@/utils/prUrl/githubFileUrl"

import type { AnswerFileReference, RenderedAnswer } from "@/entity/aiChat/chatEvent"
import type { ChatEntry, ChatTranscript, ToolActivityStatus } from "@/entity/aiChat/chatTranscript"
import { splitMessageSegments } from "@/entity/aiChat/messageSegments"
import type { ToolApprovalDecision } from "@/entity/aiChat/toolApproval"
import { type SelectableAiProviderId, TERMINAL_PROVIDERS } from "@/entity/aiReviewSettings"
import type { TerminalPromptShortcut } from "@/entity/terminalPromptShortcuts"

import type { AiSessionContext } from "@/service/aiChat/chatSession"

import { type AiChatStatus, MAX_MESSAGE_BYTES, useAiChatSession } from "@/hooks/useAiChatSession"

import { ErrorBoundary } from "@/components/ErrorBoundary"
import { MarkdownContent, type MarkdownFileReference } from "@/components/markdown/MarkdownContent"

import { AiChatApprovalCard } from "./AiChatApprovalCard"
import styles from "./AiChatSurface.module.css"

// OpenUI stays out of the eager entry chunk: both the blocks and their prompt load on demand.
const OpenUiBlock = lazy(() => import("@/components/openui/OpenUiBlock"))

async function loadReviewUiPrompt(): Promise<string> {
  const { buildReviewUiPrompt } = await import("@/components/openui/reviewUiPrompt")
  return buildReviewUiPrompt()
}

// The same props as CodexTerminal, so the panel can mount either surface at one spot.
type AiChatSurfaceProps = {
  provider: SelectableAiProviderId
  shortcuts: ReadonlyArray<TerminalPromptShortcut>
  repositoryPath: string | null
  initialPrompt: string
  model: string | null
  terminalIdentity: string
  onSessionStarted: (sessionId: string) => void
  onSessionEnded: (sessionId: string) => void
  context: AiSessionContext
}

type OpenFile = (path: string, line: number | undefined) => void
type CanOpenFile = (path: string) => boolean
type AnswerApproval = (requestId: string, decision: ToolApprovalDecision) => Promise<void>

// Blocks may write ./src/a.ts for src/a.ts. The check and the open use this one normalization.
function toRepoPath(path: string): string {
  return path.replace(/^\.\//, "")
}
type FollowUp = (text: string) => void

const TOOL_STATUS_LABELS: Record<ToolActivityStatus, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  denied: "Denied",
  stopped: "Stopped",
  interrupted: "Interrupted",
}

// WebKit (the desktop WKWebView) fires the Enter that accepts an IME candidate after
// compositionend, with isComposing false. keyCode 229 still marks it as IME input.
const IME_PROCESS_KEY_CODE = 229

// Prefilled text never replaces what the reviewer typed, it goes on a new line after it.
function appendToDraft(draft: string, text: string): string {
  return draft.trim() === "" ? text : `${draft}\n${text}`
}

// Within this distance of the bottom the transcript keeps following a streaming message.
const STICK_TO_BOTTOM_THRESHOLD_PX = 24

export function AiChatSurface({
  provider,
  shortcuts,
  repositoryPath,
  initialPrompt,
  model,
  terminalIdentity,
  onSessionStarted,
  onSessionEnded,
  context,
}: AiChatSurfaceProps) {
  const label = TERMINAL_PROVIDERS[provider].label
  const chat = useAiChatSession({
    provider,
    repositoryPath,
    initialPrompt,
    model,
    prIdentity: terminalIdentity,
    context,
    onSessionStarted,
    onSessionEnded,
    loadSystemPrompt: loadReviewUiPrompt,
  })
  const [draft, setDraft] = useState("")
  const [composerError, setComposerError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const isRunning = chat.status === "running"
  const isSessionLive = chat.status === "starting" || isRunning
  const isTurnRunning = isRunning && chat.transcript.turn === "running"
  // The transcript is busy while a turn streams, which silences it for a screen reader, and a
  // request for approval always arrives mid-turn. So a waiting request is announced on its own.
  const waitingApproval = chat.transcript.entries.findLast(
    (entry) => entry.kind === "tool_approval" && entry.approval.state === "pending"
  )
  const approvalAnnouncement =
    waitingApproval?.kind === "tool_approval"
      ? `${label} asks to run ${waitingApproval.approval.toolName}. Allow once or Deny it in the chat.`
      : ""
  const headerText = headerTitle(chat.status, isTurnRunning, label)
  // Keyed on the paths' text, not the review object: the review is rebuilt on every selection
  // or draft change, and a new array would re-render every message in the transcript.
  const prFilePathsKey = context.review?.files.map((file) => file.path).join("\n") ?? ""
  // Only a file of this PR is clickable: a click jumps the diff, and the diff has only PR files.
  const prFileReferences = useMemo<ReadonlyArray<MarkdownFileReference>>(
    () => (prFilePathsKey === "" ? [] : prFilePathsKey.split("\n").map((path) => ({ path }))),
    [prFilePathsKey]
  )

  const { openFile } = chat
  // The one answer to "is this a file of this PR". Stable while the PR's files are, because a
  // streaming block receives it again on every token.
  const canOpenFile = useCallback<CanOpenFile>(
    (path) => prFileReferences.some((reference) => reference.path === toRepoPath(path)),
    [prFileReferences]
  )
  const handleOpenFile = useCallback<OpenFile>(
    (path, line) => {
      // Backstop: a block is told what it can open, but any caller could still pass another path.
      if (!canOpenFile(path)) return

      setFileError(null)
      void openFile(toRepoPath(path), line).catch((error: unknown) => {
        setFileError(errorText(error))
      })
    },
    [canOpenFile, openFile]
  )
  // A block's follow-up lands in the composer, the reviewer decides whether to send it.
  const prefillComposer = useCallback<FollowUp>((text) => {
    setDraft((current) => appendToDraft(current, text))
    composerRef.current?.focus()
  }, [])

  function prefillShortcut(shortcut: TerminalPromptShortcut): void {
    prefillComposer(
      shortcut.buildPrompt({
        prUrl: githubPrUrl(context),
        title: context.title,
        baseSha: context.baseSha,
        headSha: context.headSha,
        selectedFile: context.selectedFilePath,
      })
    )
  }

  function sendDraft(): void {
    const result = chat.send(draft, (unsentText) => {
      setDraft((current) => appendToDraft(current, unsentText))
    })
    setComposerError(
      result === "too_long"
        ? `The message is too long to send. The limit is ${MAX_MESSAGE_BYTES / 1024} KiB.`
        : null
    )
    if (result === "sent") setDraft("")
  }

  return (
    <section className={styles.chatSection} aria-label={`${label} chat`}>
      <div className={styles.header}>
        {/* The title carries the full status, which a narrow panel truncates. */}
        <span className={styles.title} title={headerText}>
          {headerText}
        </span>
        <div className={styles.controls}>
          {chat.hasAnswer && (
            <button type="button" className={styles.action} onClick={chat.reopenAnswer}>
              Open answer
            </button>
          )}
          {(chat.status === "stopped" || chat.status === "error") && (
            <button type="button" className={styles.action} onClick={chat.launch}>
              Restart
            </button>
          )}
          {chat.status === "idle" && (
            <button type="button" className={styles.action} onClick={chat.launch}>
              Start
            </button>
          )}
          {/* Also while starting, so a start step that never finishes is never a dead end. */}
          {isSessionLive && (
            <button type="button" className={styles.action} onClick={chat.stop}>
              Stop
            </button>
          )}
        </div>
      </div>
      {shortcuts.length > 0 && (
        <div className={styles.shortcuts} role="group" aria-label="Prompt shortcuts">
          <span className={styles.shortcutsCaption} aria-hidden="true">
            Prompts
          </span>
          {/* The row exists only for the short layout's end fade (see the CSS). */}
          <div className={styles.chipRow}>
            {shortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                className={`${styles.action} ${styles.chip}`}
                disabled={!isRunning}
                title="Prefill the message, then press Enter"
                onClick={() => prefillShortcut(shortcut)}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {chat.message && (
        <p className={styles.message} role={chat.status === "error" ? "alert" : "status"}>
          {chat.message}
        </p>
      )}
      <ChatTranscriptLog
        status={chat.status}
        label={label}
        transcript={chat.transcript}
        isTurnRunning={isTurnRunning}
        prFileReferences={prFileReferences}
        onOpenFile={handleOpenFile}
        canOpenFile={canOpenFile}
        onAnswerApproval={chat.answerApproval}
        onFollowUp={prefillComposer}
      />
      {/* Mounted ahead of any text, or screen readers can miss it. Approvals only arrive while
          a session is live, so it exists only then and leaves no empty paragraph after Stop. */}
      {isSessionLive && (
        <p className={styles.visuallyHidden} aria-live="polite">
          {approvalAnnouncement}
        </p>
      )}
      {fileError && (
        <p className={styles.fileError} role="alert">
          Couldn&apos;t open the file: {fileError}
        </p>
      )}
      {composerError && (
        <p className={styles.fileError} role="alert">
          {composerError}
        </p>
      )}
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault()
          sendDraft()
        }}
      >
        <textarea
          ref={composerRef}
          className={styles.composerInput}
          aria-label={`Message ${label}`}
          placeholder={isRunning ? "Ask about this PR" : "Start the chat to send a message"}
          rows={2}
          value={draft}
          disabled={!isRunning}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // The Enter that confirms an IME candidate (Japanese, Chinese, Korean) is not a send.
            const isImeInput =
              event.nativeEvent.isComposing || event.nativeEvent.keyCode === IME_PROCESS_KEY_CODE
            // A held Enter repeats: after a block follow-up click moves focus here, the repeat
            // must not send text the model wrote. Only a fresh press sends.
            const isSendKey =
              event.key === "Enter" && !event.shiftKey && !isImeInput && !event.repeat
            if (!isSendKey) return

            event.preventDefault()
            sendDraft()
          }}
        />
        {isTurnRunning ? (
          <button type="button" className={styles.sendButton} onClick={chat.interrupt}>
            Interrupt
          </button>
        ) : (
          <button
            type="submit"
            className={styles.sendButton}
            disabled={!isRunning || draft.trim() === ""}
          >
            Send
          </button>
        )}
      </form>
    </section>
  )
}

function headerTitle(status: AiChatStatus, isTurnRunning: boolean, label: string): string {
  if (status === "starting") return `Starting ${label}…`
  if (isTurnRunning) return `${label} is replying…`

  return `${label} chat`
}

function emptyTranscriptText(status: AiChatStatus, label: string): string {
  switch (status) {
    case "idle":
      return `Start the chat to ask ${label} about this PR.`
    case "starting":
      return `Connecting to ${label}…`
    case "running":
      return "Ask a question about this PR."
    case "stopped":
      return "The chat ended before any messages."
    case "error":
      return "The chat could not start."
  }
}

type ChatTranscriptLogProps = {
  status: AiChatStatus
  label: string
  transcript: ChatTranscript
  isTurnRunning: boolean
  prFileReferences: ReadonlyArray<MarkdownFileReference>
  onOpenFile: OpenFile
  canOpenFile: CanOpenFile
  onAnswerApproval: AnswerApproval
  onFollowUp: FollowUp
}

function ChatTranscriptLog({
  status,
  label,
  transcript,
  isTurnRunning,
  prFileReferences,
  onOpenFile,
  canOpenFile,
  onAnswerApproval,
  onFollowUp,
}: ChatTranscriptLogProps) {
  const logRef = useRef<HTMLDivElement | null>(null)
  const sticksToBottomRef = useRef(true)
  const anchorRef = useRef<ScrollAnchor | null>(null)
  const lastEntry = transcript.entries.at(-1)
  const hasEntries = transcript.entries.length > 0

  useLayoutEffect(() => {
    const log = logRef.current
    if (log !== null && sticksToBottomRef.current) log.scrollTop = log.scrollHeight
  }, [transcript])

  useKeepScrollPositionOnResize(logRef, sticksToBottomRef, anchorRef, hasEntries)

  function rememberScrollPosition(): void {
    const log = logRef.current
    if (log === null) return

    const distanceFromBottom = log.scrollHeight - log.scrollTop - log.clientHeight
    sticksToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX
    anchorRef.current = sticksToBottomRef.current ? null : findScrollAnchor(log)
  }

  return (
    <div
      ref={logRef}
      className={styles.transcript}
      role="log"
      aria-label="Chat transcript"
      // Busy while a message streams, so a screen reader reads the finished message once.
      aria-busy={isTurnRunning}
      tabIndex={0}
      onScroll={rememberScrollPosition}
    >
      {transcript.entries.length === 0 ? (
        <p className={styles.emptyState}>{emptyTranscriptText(status, label)}</p>
      ) : (
        <ol className={styles.entries}>
          {transcript.entries.map((entry) => (
            <ChatEntryView
              key={entry.id}
              entry={entry}
              label={label}
              isStreaming={isTurnRunning && entry === lastEntry}
              prFileReferences={prFileReferences}
              onOpenFile={onOpenFile}
              canOpenFile={canOpenFile}
              onAnswerApproval={onAnswerApproval}
              onFollowUp={onFollowUp}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

// The block at the top of the visible transcript, and how far its top sits from the view top.
// The deepest block there, not the whole entry: one long answer grows taller at a narrower
// width, and holding only its top would push the paragraph being read out of the view.
type ScrollAnchor = {
  node: Element
  offsetFromViewTop: number
}

function findScrollAnchor(log: HTMLElement): ScrollAnchor | null {
  const viewTop = log.getBoundingClientRect().top
  const entries = log.firstElementChild
  let anchor = entries === null ? null : firstBlockBelowViewTop(entries, viewTop)
  if (anchor === null) return null

  // A block that starts above the view has a child that starts closer to it.
  while (anchor.getBoundingClientRect().top < viewTop) {
    const child = firstBlockBelowViewTop(anchor, viewTop)
    if (child === null) break

    anchor = child
  }

  return { node: anchor, offsetFromViewTop: anchor.getBoundingClientRect().top - viewTop }
}

// Stops at an inline box: a run of text that wraps reports one box for all of its lines.
function firstBlockBelowViewTop(parent: Element, viewTop: number): Element | null {
  for (const child of parent.children) {
    const isBelowViewTop = child.getBoundingClientRect().bottom > viewTop
    if (!isBelowViewTop) continue

    return getComputedStyle(child).display === "inline" ? null : child
  }

  return null
}

// A panel drag resizes the transcript without changing it, so the effect on [transcript] never
// runs. A ResizeObserver on the log (its own box) and its list (the content reflowing at the
// new width) puts the view back: at the bottom when it was pinned there, else on the entry that
// was at the top of the view. By hand, not CSS scroll anchoring, which WebKit does not offer.
// The callback only reads layout and writes scrollTop, so a drag causes no React render.
function useKeepScrollPositionOnResize(
  logRef: RefObject<HTMLDivElement | null>,
  sticksToBottomRef: RefObject<boolean>,
  anchorRef: RefObject<ScrollAnchor | null>,
  hasEntries: boolean
): void {
  useEffect(() => {
    const log = logRef.current
    if (log === null || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(() => {
      if (sticksToBottomRef.current) {
        log.scrollTop = log.scrollHeight
        return
      }

      const anchor = anchorRef.current
      if (!anchor?.node.isConnected) return

      const viewTop = log.getBoundingClientRect().top
      const drift = anchor.node.getBoundingClientRect().top - viewTop - anchor.offsetFromViewTop
      log.scrollTop += drift
    })
    observer.observe(log)
    if (log.firstElementChild !== null) observer.observe(log.firstElementChild)

    return () => observer.disconnect()
  }, [logRef, sticksToBottomRef, anchorRef, hasEntries])
}

type ChatEntryViewProps = {
  entry: ChatEntry
  label: string
  isStreaming: boolean
  prFileReferences: ReadonlyArray<MarkdownFileReference>
  onOpenFile: OpenFile
  canOpenFile: CanOpenFile
  onAnswerApproval: AnswerApproval
  onFollowUp: FollowUp
}

// Memoized: entries that did not change keep their object identity in the transcript,
// so only the message that is streaming re-renders its markdown.
const ChatEntryView = memo(function ChatEntryView({
  entry,
  label,
  isStreaming,
  prFileReferences,
  onOpenFile,
  canOpenFile,
  onAnswerApproval,
  onFollowUp,
}: ChatEntryViewProps) {
  switch (entry.kind) {
    case "user_message":
      return (
        <li className={styles.userMessage}>
          <span className={styles.author}>You</span>
          <p className={styles.userText}>{entry.text}</p>
        </li>
      )
    case "assistant_message":
      return (
        <li className={styles.assistantMessage}>
          <span className={styles.author}>{label}</span>
          <AssistantMessage
            text={entry.text}
            isStreaming={isStreaming}
            prFileReferences={prFileReferences}
            onOpenFile={onOpenFile}
            canOpenFile={canOpenFile}
            onFollowUp={onFollowUp}
          />
        </li>
      )
    case "tool_activity":
      return (
        <li className={styles.toolRow} data-status={entry.status}>
          <span className={styles.toolName} title={entry.toolName}>
            {entry.toolName}
          </span>
          {entry.summary && (
            <span className={styles.toolSummary} title={entry.summary}>
              {entry.summary}
            </span>
          )}
          <span className={styles.toolStatus}>{TOOL_STATUS_LABELS[entry.status]}</span>
        </li>
      )
    case "notice":
      return (
        <li className={styles.notice} data-tone={entry.tone}>
          {entry.text}
        </li>
      )
    case "answer":
      return (
        <li className={styles.assistantMessage}>
          <span className={styles.author}>{label} · answer</span>
          <AnswerView
            answer={entry.answer}
            prFileReferences={prFileReferences}
            onOpenFile={onOpenFile}
          />
        </li>
      )
    case "tool_approval":
      return (
        <AiChatApprovalCard
          approval={entry.approval}
          agentLabel={label}
          onAnswer={onAnswerApproval}
        />
      )
  }
})

// The agent often writes the line into the label already ("campaign_action.go:47"),
// so the line is added only when the label does not end with it.
function answerFileText(reference: AnswerFileReference): string {
  const name = reference.label ?? reference.path
  if (reference.line === null) return name

  const lineSuffix = `:${reference.line}`
  return name.endsWith(lineSuffix) ? name : `${name}${lineSuffix}`
}

type AnswerViewProps = {
  answer: RenderedAnswer
  prFileReferences: ReadonlyArray<MarkdownFileReference>
  onOpenFile: OpenFile
}

// Same rules as chat prose (strict URLs, only PR files clickable). The answer window is where
// a reviewer pops it out to, for example to see a mermaid diagram rendered.
function AnswerView({ answer, prFileReferences, onOpenFile }: AnswerViewProps) {
  const prPaths = new Set(prFileReferences.map((reference) => reference.path))
  // The answer's own lines come first, so a bare mention of a cited file opens at that line.
  const fileReferences = [
    ...answer.fileReferences
      .filter((reference) => prPaths.has(reference.path))
      .map((reference) =>
        reference.line === null
          ? { path: reference.path }
          : { path: reference.path, line: reference.line }
      ),
    ...prFileReferences,
  ]

  return (
    <div className={styles.messageBody}>
      <h3 className={styles.answerTitle}>{answer.title}</h3>
      <div className={styles.prose}>
        <MarkdownContent
          source={answer.markdown}
          variant="inline"
          urlPolicy="strict"
          fileReferences={fileReferences}
          onOpenFile={(reference) => onOpenFile(reference.path, reference.line)}
        />
      </div>
      {answer.fileReferences.length > 0 && (
        <ul className={styles.answerFiles} aria-label="Referenced files">
          {answer.fileReferences.map((reference) => {
            const text = answerFileText(reference)
            const key = `${reference.path}:${reference.line ?? ""}`
            if (!prPaths.has(reference.path)) return <li key={key}>{text}</li>

            return (
              <li key={key}>
                <button
                  type="button"
                  className={styles.answerFileButton}
                  onClick={() => onOpenFile(reference.path, reference.line ?? undefined)}
                >
                  {text}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

type AssistantMessageProps = {
  text: string
  isStreaming: boolean
  prFileReferences: ReadonlyArray<MarkdownFileReference>
  onOpenFile: OpenFile
  canOpenFile: CanOpenFile
  onFollowUp: FollowUp
}

function AssistantMessage({
  text,
  isStreaming,
  prFileReferences,
  onOpenFile,
  canOpenFile,
  onFollowUp,
}: AssistantMessageProps) {
  const segments = useMemo(
    () => splitMessageSegments(text, { streaming: isStreaming }),
    [isStreaming, text]
  )

  // Segments only ever grow at the end while streaming, so their index is a stable key.
  return (
    <div className={styles.messageBody}>
      {segments.map((segment, index) =>
        segment.kind === "prose" ? (
          <div key={index} className={styles.prose}>
            <MarkdownContent
              source={segment.text}
              variant="inline"
              // The agent may be steered by the PR it reads: no fetch of a URL it chose, https only.
              urlPolicy="strict"
              fileReferences={prFileReferences}
              onOpenFile={(reference) => onOpenFile(reference.path, reference.line)}
            />
          </div>
        ) : (
          <ErrorBoundary
            key={index}
            fallback={() => (
              <div className={styles.blockError} role="alert">
                <p>This block could not be shown. Its source:</p>
                <pre className={styles.blockSource}>{segment.code}</pre>
              </div>
            )}
          >
            <Suspense fallback={<p className={styles.blockLoading}>Loading block…</p>}>
              <OpenUiBlock
                code={segment.code}
                streaming={isStreaming && !segment.closed}
                onOpenFile={onOpenFile}
                canOpenFile={canOpenFile}
                onFollowUp={onFollowUp}
              />
            </Suspense>
          </ErrorBoundary>
        )
      )}
    </div>
  )
}
