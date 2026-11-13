import type { ToolApproval } from "./toolApproval"

// What happened in a chat, in provider-neutral words.
// A provider adapter (service/aiChat/claudeStreamEvents.ts) turns one raw line into zero or more
// of these, and the chat surface adds the reviewer's own messages. No wire detail belongs here.

type ToolOutcome = "done" | "failed" | "interrupted"

// A file an answer points at. line and label are null when the agent gave none.
export type AnswerFileReference = { path: string; line: number | null; label: string | null }

// A titled answer the agent rendered through the app's own tool, shown inline in the chat.
export type RenderedAnswer = {
  title: string
  markdown: string
  fileReferences: ReadonlyArray<AnswerFileReference>
}

export type TurnOutcome = "completed" | "interrupted" | "failed"

export type ChatEvent =
  | { kind: "user_message_sent"; text: string }
  // The first turn carries the whole PR briefing, which the transcript shows only as a notice.
  | { kind: "pr_context_sent" }
  // partId names one text part of an assistant message, so its deltas join into one entry.
  | { kind: "assistant_text_delta"; partId: string; text: string }
  // Sent when the call begins (summary still unknown) and again once its input is complete.
  | { kind: "tool_started"; toolCallId: string; toolName: string; summary: string | null }
  | { kind: "tool_finished"; toolCallId: string; outcome: ToolOutcome }
  // announce: no approval card records this denial, so the transcript needs a notice for it.
  | { kind: "tool_denied"; toolCallId: string; toolName: string; announce: boolean }
  // A request to approve a tool call, sent again on every change of its state.
  | { kind: "tool_approval_changed"; approval: ToolApproval }
  // message is the provider's own reason for a failed turn, null when it gave none.
  | { kind: "turn_ended"; outcome: TurnOutcome; message: string | null }
  | { kind: "answer_rendered"; answer: RenderedAnswer }
  // The provider's reply to a model change. The session matches it to its own request.
  | {
      kind: "model_change_answered"
      requestId: string
      accepted: boolean
      // The model the session runs on after the reply, as the provider names it.
      resolvedModel: string | null
      error: string | null
      // The provider's code for a refusal, such as "not_found".
      errorCode: string | null
    }
  // The model the provider says the session runs on, sent at the start of every turn.
  | { kind: "model_reported"; resolvedModel: string }
  | { kind: "model_changed"; modelName: string }
  | { kind: "approvals_unavailable" }
  // previousModelName is null when the app cannot name the model the chat stays on.
  | {
      kind: "model_change_refused"
      modelName: string
      previousModelName: string | null
      reason: string
      // False when the model does not exist, so the notice makes no promise about the next Start.
      staysSelected: boolean
    }
  // The process is gone (Stop, crash), so nothing still open in the transcript will finish.
  | { kind: "session_ended" }
