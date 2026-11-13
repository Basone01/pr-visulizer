import { z } from "zod"

import type { ChatEvent, TurnOutcome } from "@/entity/aiChat/chatEvent"

// Claude Code's `--output-format stream-json --include-partial-messages` dialect, as observed on
// 2.1.322 (fixtures in ./__fixtures__/claude). One stdout line in, provider-neutral events out.
// Unknown or malformed lines map to no events: the CLI adds line types between releases.
//
// Reply text comes ONLY from text_delta stream events. The complete `assistant` line and
// `result.result` repeat the same text, so reading them as well would print every reply twice.

const lineEnvelopeSchema = z.object({
  type: z.string(),
  // Set on lines a subagent produces inside a tool call. Those belong to that call, not the reply.
  parent_tool_use_id: z.string().nullable().optional(),
})

const streamEventLineSchema = z.object({
  type: z.literal("stream_event"),
  api_message_id: z.string().min(1).optional(),
  event: z.unknown(),
})

const textDeltaEventSchema = z.object({
  type: z.literal("content_block_delta"),
  index: z.number().int().nonnegative(),
  delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
})

const toolUseStartEventSchema = z.object({
  type: z.literal("content_block_start"),
  content_block: z.object({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
})

const assistantLineSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
})

// The full tool input arrives here, the input_json_delta chunks before it are only partial JSON.
const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
})

const userLineSchema = z.object({
  type: z.literal("user"),
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
})

// is_error is left out on success.
const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
})

const permissionDeniedLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("permission_denied"),
  tool_name: z.string().min(1),
  tool_use_id: z.string().min(1),
})

const resultLineSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  // On an is_error "success" this carries the CLI's own error text instead of an answer.
  result: z.string().optional(),
  api_error_status: z.number().int().nullable().optional(),
})

type ResultLine = z.infer<typeof resultLineSchema>

const MAX_TURNS_MESSAGE = "Stopped after the maximum number of turns."
// The CLI's text can be a whole stack trace or payload, the notice shows only its start.
const MAX_FAILURE_MESSAGE_LENGTH = 2000

// The first of these keys present in a tool's input is the one-line summary the reviewer sees.
const TOOL_SUMMARY_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query"]

// MCP tools arrive as mcp__<server>__<tool>, the reviewer only needs the tool part.
const MCP_TOOL_PREFIX = /^mcp__.+?__/

export function parseClaudeStreamLine(line: string): ChatEvent[] {
  const json = parseJson(line)
  const envelope = lineEnvelopeSchema.safeParse(json)
  if (!envelope.success) return []

  const isSubagentLine = typeof envelope.data.parent_tool_use_id === "string"
  if (isSubagentLine) return []

  switch (envelope.data.type) {
    case "stream_event":
      return streamEventToChatEvents(json)
    case "assistant":
      return assistantLineToChatEvents(json)
    case "user":
      return userLineToChatEvents(json)
    case "system":
      return systemLineToChatEvents(json)
    case "result":
      return resultLineToChatEvents(json)
    default:
      return []
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function streamEventToChatEvents(json: unknown): ChatEvent[] {
  const line = streamEventLineSchema.safeParse(json)
  if (!line.success) return []

  const textDelta = textDeltaEventSchema.safeParse(line.data.event)
  if (textDelta.success) {
    // Each content block of each API message is its own text part.
    const partId = `${line.data.api_message_id ?? "message"}:${textDelta.data.index}`
    return [{ kind: "assistant_text_delta", partId, text: textDelta.data.delta.text }]
  }

  const toolStart = toolUseStartEventSchema.safeParse(line.data.event)
  if (toolStart.success) {
    const block = toolStart.data.content_block
    return [
      { kind: "tool_started", toolCallId: block.id, toolName: toolName(block.name), summary: null },
    ]
  }

  return []
}

function assistantLineToChatEvents(json: unknown): ChatEvent[] {
  const line = assistantLineSchema.safeParse(json)
  if (!line.success) return []

  return line.data.message.content.flatMap((block): ChatEvent[] => {
    const toolUse = toolUseBlockSchema.safeParse(block)
    if (!toolUse.success) return []

    return [
      {
        kind: "tool_started",
        toolCallId: toolUse.data.id,
        toolName: toolName(toolUse.data.name),
        summary: summarizeToolInput(toolUse.data.input),
      },
    ]
  })
}

function userLineToChatEvents(json: unknown): ChatEvent[] {
  const line = userLineSchema.safeParse(json)
  if (!line.success || typeof line.data.message.content === "string") return []

  return line.data.message.content.flatMap((block): ChatEvent[] => {
    const toolResult = toolResultBlockSchema.safeParse(block)
    if (!toolResult.success) return []

    const outcome = toolResult.data.is_error === true ? "failed" : "done"
    return [{ kind: "tool_finished", toolCallId: toolResult.data.tool_use_id, outcome }]
  })
}

function systemLineToChatEvents(json: unknown): ChatEvent[] {
  const denied = permissionDeniedLineSchema.safeParse(json)
  if (!denied.success) return []

  return [
    {
      kind: "tool_denied",
      toolCallId: denied.data.tool_use_id,
      toolName: toolName(denied.data.tool_name),
    },
  ]
}

function resultLineToChatEvents(json: unknown): ChatEvent[] {
  const result = resultLineSchema.safeParse(json)
  if (!result.success) return []

  const outcome = turnOutcome(result.data)
  const message = outcome === "failed" ? failureMessage(result.data) : null
  return [{ kind: "turn_ended", outcome, message }]
}

// A denied tool still ends in subtype "success", the denial reaches the transcript on its own line.
function turnOutcome(result: ResultLine): TurnOutcome {
  if (result.subtype === "error_during_execution") return "interrupted"
  if (result.subtype === "success" && result.is_error !== true) return "completed"

  return "failed"
}

// The `errors` list is left out on purpose: it holds internal diagnostics, not reviewer text.
function failureMessage(result: ResultLine): string | null {
  const statusSuffix = result.api_error_status ? ` (API status ${result.api_error_status})` : ""
  if (result.subtype === "error_max_turns") return MAX_TURNS_MESSAGE + statusSuffix

  const cliText = result.result?.trim() ?? ""
  // A stringified missing value ("undefined") is not a reason the reviewer can use.
  const hasCliText = cliText !== "" && cliText !== "undefined"
  if (hasCliText) return truncate(cliText, MAX_FAILURE_MESSAGE_LENGTH) + statusSuffix
  if (statusSuffix !== "") return `The answer ended with an error${statusSuffix}.`

  return null
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function toolName(rawName: string): string {
  return rawName.replace(MCP_TOOL_PREFIX, "")
}

function summarizeToolInput(input: Record<string, unknown>): string | null {
  for (const key of TOOL_SUMMARY_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }

  return null
}
