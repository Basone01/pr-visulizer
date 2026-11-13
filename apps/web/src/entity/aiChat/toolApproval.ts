import { z } from "zod"

import { escapeHiddenCharacters } from "@/utils/text/bidiControls"

// A tool call the agent asks the reviewer to approve, as the app reports it on every state
// change (CONTRACT.md 6.6, frozen). pending comes first, then exactly one end state. An app
// denial without asking (too large, too many pending) arrives as a single denied event.
export const toolApprovalEventSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  // The exact input the app stored. null only when it was too large to show.
  input: z.record(z.string(), z.unknown()).nullable(),
  state: z.enum(["pending", "allowed", "denied", "cancelled", "expired"]),
  deniedBy: z.enum(["reviewer", "app"]).nullable(),
  reason: z.string().nullable(),
})

export type ToolApprovalEvent = z.infer<typeof toolApprovalEventSchema>

// The transcript's copy: the session is already known where it is kept.
export type ToolApproval = Omit<ToolApprovalEvent, "sessionId">

export type ToolApprovalDecision = "allow" | "deny"

export function isPendingApproval(approval: ToolApproval): boolean {
  return approval.state === "pending"
}

// What the card shows. Nothing is ever cut, and hidden characters are escaped, never dropped,
// so the reviewer sees exactly what would run.
export type ApprovalInputView =
  | { kind: "too_large" }
  | {
      kind: "command"
      command: string
      agentNote: string | null
      // Every other key the allow forwards (run_in_background, timeout, ...), as pretty JSON.
      otherOptions: string | null
      hasHiddenCharacters: boolean
    }
  | { kind: "input"; json: string; hasHiddenCharacters: boolean }

const BASH_TOOL_NAME = "Bash"

export function describeApprovalInput(approval: ToolApproval): ApprovalInputView {
  const input = approval.input
  if (input === null) return { kind: "too_large" }

  const command = input["command"]
  const isShellCommand = approval.toolName === BASH_TOOL_NAME && typeof command === "string"
  if (!isShellCommand) {
    const json = escapeHiddenCharacters(JSON.stringify(input, null, 2))
    return { kind: "input", json: json.text, hasHiddenCharacters: json.hadHidden }
  }

  const escapedCommand = escapeHiddenCharacters(command)
  const description = input["description"]
  const escapedNote = typeof description === "string" ? escapeHiddenCharacters(description) : null
  // Every key the card does not show on its own goes under "Other options", because the allow
  // forwards the whole input. A description that is not text is one of them.
  const keysShownOnTheirOwn = escapedNote === null ? ["command"] : ["command", "description"]
  const otherEntries = Object.entries(input).filter(([key]) => !keysShownOnTheirOwn.includes(key))
  const escapedOptions =
    otherEntries.length === 0
      ? null
      : escapeHiddenCharacters(JSON.stringify(Object.fromEntries(otherEntries), null, 2))
  return {
    kind: "command",
    command: escapedCommand.text,
    agentNote: escapedNote?.text ?? null,
    otherOptions: escapedOptions?.text ?? null,
    hasHiddenCharacters:
      escapedCommand.hadHidden ||
      (escapedNote?.hadHidden ?? false) ||
      (escapedOptions?.hadHidden ?? false),
  }
}

// A run of this many blank lines or more is drawn as one marker line, so padding can never push
// the rest of a command out of sight with nothing to show it is there (CONTRACT.md §10, F5).
const MIN_FOLDED_BLANK_LINES = 3

export type DisplayedTextPart =
  { kind: "text"; text: string } | { kind: "blank_lines"; count: number }

export type DisplayedText = { parts: DisplayedTextPart[]; lineCount: number }

// Splits text into what the card draws: text as it is, and each long run of blank or
// whitespace-only lines as one counted marker. lineCount is the real number of lines.
export function foldBlankLines(text: string): DisplayedText {
  const lines = text.split("\n")
  const parts: DisplayedTextPart[] = []
  let textLines: string[] = []
  let index = 0

  while (index < lines.length) {
    const blankRunEnd = findBlankRunEnd(lines, index)
    const blankRunLength = blankRunEnd - index
    if (blankRunLength < MIN_FOLDED_BLANK_LINES) {
      textLines.push(lines[index] ?? "")
      index += 1
      continue
    }

    if (textLines.length > 0) parts.push({ kind: "text", text: textLines.join("\n") })
    textLines = []
    parts.push({ kind: "blank_lines", count: blankRunLength })
    index = blankRunEnd
  }
  if (textLines.length > 0) parts.push({ kind: "text", text: textLines.join("\n") })

  return { parts, lineCount: lines.length }
}

function findBlankRunEnd(lines: ReadonlyArray<string>, start: number): number {
  let end = start
  while (end < lines.length && (lines[end] ?? "").trim() === "") end += 1
  return end
}

// The record a finished card reads as, saying who decided.
export function approvalOutcomeText(approval: ToolApproval): string | null {
  const withReason = (label: string): string =>
    approval.reason === null || approval.reason === "" ? label : `${label}: ${approval.reason}`

  switch (approval.state) {
    case "pending":
      return null
    case "allowed":
      return "Allowed"
    case "denied":
      return approval.deniedBy === "reviewer" ? "Denied by you" : withReason("Denied by the app")
    case "cancelled":
      return withReason("Cancelled")
    case "expired":
      return withReason("Expired")
  }
}
