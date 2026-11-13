import type { ChatEvent, RenderedAnswer, TurnOutcome } from "./chatEvent"

// stopped: the turn or the process ended before the tool reported a result.
export type ToolActivityStatus = "running" | "done" | "failed" | "denied" | "stopped"

export type ChatEntry =
  | { kind: "user_message"; id: number; text: string }
  | { kind: "assistant_message"; id: number; partId: string; text: string }
  | {
      kind: "tool_activity"
      id: number
      toolCallId: string
      toolName: string
      // The command or path the tool works on, null until the provider sends the full input.
      summary: string | null
      status: ToolActivityStatus
    }
  | { kind: "notice"; id: number; tone: "info" | "warning"; text: string }
  // Appended when the answer arrives, which is while its tool row is still running.
  | { kind: "answer"; id: number; answer: RenderedAnswer }

export type ChatTranscript = {
  entries: ReadonlyArray<ChatEntry>
  turn: "idle" | "running"
  nextEntryId: number
}

// Omit on a union merges the variants into one shape, so it is applied to each variant on its own.
type OmitFromEachVariant<Union, Key extends PropertyKey> = Union extends unknown
  ? Omit<Union, Key>
  : never
type NewChatEntry = OmitFromEachVariant<ChatEntry, "id">

type ToolActivityEntry = Extract<ChatEntry, { kind: "tool_activity" }>

export const EMPTY_CHAT_TRANSCRIPT: ChatTranscript = { entries: [], turn: "idle", nextEntryId: 1 }

export const PR_CONTEXT_SENT_NOTICE = "PR context sent"

const TURN_END_NOTICES: Record<TurnOutcome, string | null> = {
  completed: null,
  interrupted: "Interrupted.",
  failed: "The answer ended with an error.",
}

export function applyChatEvents(
  transcript: ChatTranscript,
  events: ReadonlyArray<ChatEvent>
): ChatTranscript {
  return events.reduce(applyChatEvent, transcript)
}

function applyChatEvent(transcript: ChatTranscript, event: ChatEvent): ChatTranscript {
  switch (event.kind) {
    case "user_message_sent":
      return startTurn(appendEntry(transcript, { kind: "user_message", text: event.text }))
    case "pr_context_sent":
      return startTurn(
        appendEntry(transcript, { kind: "notice", tone: "info", text: PR_CONTEXT_SENT_NOTICE })
      )
    case "assistant_text_delta":
      return appendAssistantText(transcript, event.partId, event.text)
    case "tool_started":
      return startToolActivity(transcript, event.toolCallId, event.toolName, event.summary)
    case "tool_finished":
      return updateToolActivity(transcript, event.toolCallId, (tool) =>
        tool.status === "running" ? { ...tool, status: event.outcome } : tool
      )
    case "tool_denied":
      return denyToolActivity(transcript, event.toolCallId, event.toolName)
    case "turn_ended":
      return endTurn(transcript, event.outcome, event.message)
    case "answer_rendered":
      return appendEntry(transcript, { kind: "answer", answer: event.answer })
    case "session_ended":
      return stopRunningTools({ ...transcript, turn: "idle" })
  }
}

function startTurn(transcript: ChatTranscript): ChatTranscript {
  return { ...transcript, turn: "running" }
}

function endTurn(
  transcript: ChatTranscript,
  outcome: TurnOutcome,
  message: string | null
): ChatTranscript {
  const idleTranscript = stopRunningTools({ ...transcript, turn: "idle" })
  const notice = TURN_END_NOTICES[outcome]
  if (notice === null) return idleTranscript

  const text = outcome === "failed" && message !== null ? message : notice
  return appendEntry(idleTranscript, { kind: "notice", tone: "warning", text })
}

// A tool that has not reported by the end of its turn never will, so it must not read "Running".
function stopRunningTools(transcript: ChatTranscript): ChatTranscript {
  const hasRunningTool = transcript.entries.some(
    (entry) => entry.kind === "tool_activity" && entry.status === "running"
  )
  if (!hasRunningTool) return transcript

  const entries = transcript.entries.map((entry): ChatEntry =>
    entry.kind === "tool_activity" && entry.status === "running"
      ? { ...entry, status: "stopped" }
      : entry
  )
  return { ...transcript, entries }
}

function appendEntry(transcript: ChatTranscript, entry: NewChatEntry): ChatTranscript {
  const id = transcript.nextEntryId
  return {
    ...transcript,
    entries: [...transcript.entries, { ...entry, id } as ChatEntry],
    nextEntryId: id + 1,
  }
}

// A delta joins the assistant message it belongs to only while that message is the newest entry,
// so a tool row between two text parts keeps them in reading order.
function appendAssistantText(
  transcript: ChatTranscript,
  partId: string,
  text: string
): ChatTranscript {
  const lastEntry = transcript.entries.at(-1)
  const continuesLastMessage =
    lastEntry?.kind === "assistant_message" && lastEntry.partId === partId
  if (!continuesLastMessage) {
    return appendEntry(transcript, { kind: "assistant_message", partId, text })
  }

  const entries = [
    ...transcript.entries.slice(0, -1),
    { ...lastEntry, text: lastEntry.text + text },
  ]
  return { ...transcript, entries }
}

function startToolActivity(
  transcript: ChatTranscript,
  toolCallId: string,
  toolName: string,
  summary: string | null
): ChatTranscript {
  const isKnownTool = transcript.entries.some(
    (entry) => entry.kind === "tool_activity" && entry.toolCallId === toolCallId
  )
  if (!isKnownTool) {
    return appendEntry(transcript, {
      kind: "tool_activity",
      toolCallId,
      toolName,
      summary,
      status: "running",
    })
  }

  return updateToolActivity(transcript, toolCallId, (tool) => ({
    ...tool,
    summary: summary ?? tool.summary,
  }))
}

function denyToolActivity(
  transcript: ChatTranscript,
  toolCallId: string,
  toolName: string
): ChatTranscript {
  const deniedTranscript = updateToolActivity(transcript, toolCallId, (tool) => ({
    ...tool,
    status: "denied",
  }))

  return appendEntry(deniedTranscript, {
    kind: "notice",
    tone: "warning",
    text: `${toolName} needed approval, and this chat cannot approve actions yet.`,
  })
}

function updateToolActivity(
  transcript: ChatTranscript,
  toolCallId: string,
  update: (tool: ToolActivityEntry) => ToolActivityEntry
): ChatTranscript {
  const entries = transcript.entries.map((entry) =>
    entry.kind === "tool_activity" && entry.toolCallId === toolCallId ? update(entry) : entry
  )
  return { ...transcript, entries }
}
