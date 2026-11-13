import type { ChatEvent, RenderedAnswer, TurnOutcome } from "./chatEvent"
import { type ToolApproval, isPendingApproval } from "./toolApproval"

// stopped: the turn or the process ended before the tool reported a result.
// interrupted: the call never ran because the reviewer interrupted the turn, it was not denied.
export type ToolActivityStatus =
  "running" | "done" | "failed" | "denied" | "stopped" | "interrupted"

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
  // Placed where the request arrived. Its state only ever comes from the app's events.
  | { kind: "tool_approval"; id: number; approval: ToolApproval }

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
export const APPROVALS_UNAVAILABLE_NOTICE =
  "This chat cannot show approval requests, commands that need approval will be denied."

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
      return denyToolActivity(transcript, event.toolCallId, event.toolName, event.announce)
    case "tool_approval_changed":
      return applyToolApproval(transcript, event.approval)
    case "turn_ended":
      return endTurn(transcript, event.outcome, event.message)
    case "answer_rendered":
      return appendEntry(transcript, { kind: "answer", answer: event.answer })
    case "model_change_answered":
    case "model_reported":
      // Only the session knows which request it made, it turns the reply into one of the two below.
      return transcript
    case "approvals_unavailable":
      return appendEntry(transcript, {
        kind: "notice",
        tone: "warning",
        text: APPROVALS_UNAVAILABLE_NOTICE,
      })
    case "model_changed":
      return appendEntry(transcript, {
        kind: "notice",
        tone: "info",
        text: `Model changed to ${event.modelName}. It answers from the next message.`,
      })
    case "model_change_refused":
      return appendEntry(transcript, {
        kind: "notice",
        tone: "warning",
        text: modelChangeRefusedText(event),
      })
    case "session_ended":
      return stopRunningTools({ ...transcript, turn: "idle" })
  }
}

function modelChangeRefusedText(
  refusal: Extract<ChatEvent, { kind: "model_change_refused" }>
): string {
  const stillOn = refusal.previousModelName ?? "the previous model"
  const refused = `Couldn't switch to ${refusal.modelName} (${refusal.reason}). The chat is still on ${stillOn}.`
  return refusal.staysSelected
    ? `${refused} ${refusal.modelName} stays selected for the next Start.`
    : refused
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
  toolName: string,
  announce: boolean
): ChatTranscript {
  // An interrupted turn lists the call it cut off as a denial too, but nobody denied it.
  const deniedTranscript = updateToolActivity(transcript, toolCallId, (tool) =>
    tool.status === "interrupted" ? tool : { ...tool, status: "denied" }
  )
  if (!announce) return deniedTranscript

  return appendEntry(deniedTranscript, {
    kind: "notice",
    tone: "warning",
    text: `${toolName} was denied without asking you.`,
  })
}

// The first event for a request adds its entry, whatever its state (an app denial has no
// pending before it). A pending entry then takes exactly one end state, and nothing after it.
function applyToolApproval(transcript: ChatTranscript, approval: ToolApproval): ChatTranscript {
  const index = transcript.entries.findIndex(
    (entry) => entry.kind === "tool_approval" && entry.approval.requestId === approval.requestId
  )
  const existing = transcript.entries[index]
  if (existing?.kind !== "tool_approval") {
    return appendEntry(transcript, { kind: "tool_approval", approval })
  }

  const canChange = isPendingApproval(existing.approval) && !isPendingApproval(approval)
  if (!canChange) return transcript

  const entries = transcript.entries.with(index, { ...existing, approval })
  return { ...transcript, entries }
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
