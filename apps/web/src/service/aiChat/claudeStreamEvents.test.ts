import { describe, expect, it } from "vitest"

import {
  type ChatEntry,
  type ChatTranscript,
  EMPTY_CHAT_TRANSCRIPT,
  applyChatEvents,
} from "@/entity/aiChat/chatTranscript"

import deniedThenInterruptedFixture from "./__fixtures__/claude/denied-then-interrupted-four-turns.jsonl?raw"
import deniedTurnFixture from "./__fixtures__/claude/denied-turn.jsonl?raw"
import textTurnFixture from "./__fixtures__/claude/text-turn.jsonl?raw"
import toolTurnFixture from "./__fixtures__/claude/tool-turn.jsonl?raw"
import { parseClaudeStreamLine } from "./claudeStreamEvents"

// Real Claude Code 2.1.322 captures, sanitized. See the spike notes for how they were recorded.

function fixtureLines(fixture: string): string[] {
  return fixture.split("\n").filter((line) => line.trim() !== "")
}

function replayLines(lines: ReadonlyArray<string>, transcript = EMPTY_CHAT_TRANSCRIPT) {
  return lines.reduce(
    (current: ChatTranscript, line) => applyChatEvents(current, parseClaudeStreamLine(line)),
    transcript
  )
}

// Key order differs between line types, so the type is read from the parsed line.
function lineType(line: string): unknown {
  return (JSON.parse(line) as { type?: unknown }).type
}

function startedTurn(): ChatTranscript {
  return applyChatEvents(EMPTY_CHAT_TRANSCRIPT, [{ kind: "user_message_sent", text: "Hi" }])
}

function entriesOfKind<Kind extends ChatEntry["kind"]>(
  transcript: ChatTranscript,
  kind: Kind
): Array<Extract<ChatEntry, { kind: Kind }>> {
  return transcript.entries.filter(
    (entry): entry is Extract<ChatEntry, { kind: Kind }> => entry.kind === kind
  )
}

describe("Claude stream-json to chat transcript", () => {
  it("a_streamed_message_becomes_one_assistant_entry_with_the_text_exactly_once", () => {
    // Arrange
    const lines = fixtureLines(textTurnFixture)
    const firstTurnEnd = lines.findIndex((line) => lineType(line) === "result")
    const firstTurnLines = lines.slice(0, firstTurnEnd + 1)

    // Act
    const transcript = replayLines(firstTurnLines, startedTurn())

    // Assert
    const expected = ["Got it, I'll remember 4817."]
    expect(entriesOfKind(transcript, "assistant_message").map((entry) => entry.text)).toEqual(
      expected
    )
  })

  it("a_finished_turn_returns_the_transcript_to_idle", () => {
    // Arrange
    const lines = fixtureLines(textTurnFixture)

    // Act
    const transcript = replayLines(lines, startedTurn())

    // Assert
    expect(transcript.turn).toBe("idle")
  })

  it("a_tool_call_shows_as_running_with_its_path_before_its_result_arrives", () => {
    // Arrange
    const lines = fixtureLines(toolTurnFixture)
    const toolResultIndex = lines.findIndex((line) => lineType(line) === "user")
    const linesBeforeResult = lines.slice(0, toolResultIndex)

    // Act
    const transcript = replayLines(linesBeforeResult, startedTurn())

    // Assert
    const expected = [
      {
        kind: "tool_activity",
        id: 2,
        toolCallId: "toolu_01",
        toolName: "Read",
        summary: "<REPO>/README.md",
        status: "running",
      },
    ]
    expect(entriesOfKind(transcript, "tool_activity")).toEqual(expected)
  })

  it("a_tool_call_shows_as_done_after_its_result", () => {
    // Arrange
    const lines = fixtureLines(toolTurnFixture)

    // Act
    const transcript = replayLines(lines, startedTurn())

    // Assert
    const expected = ["done"]
    expect(entriesOfKind(transcript, "tool_activity").map((entry) => entry.status)).toEqual(
      expected
    )
  })

  it("a_tool_turn_keeps_its_entries_in_reading_order", async () => {
    // Arrange
    const lines = fixtureLines(toolTurnFixture)

    // Act
    const transcript = replayLines(lines, startedTurn())

    // Assert
    await expect(JSON.stringify(transcript, null, 2)).toMatchFileSnapshot(
      "./__golden__/tool-turn.transcript.json"
    )
  })

  it("a_denied_tool_shows_as_denied_with_its_command", () => {
    // Arrange
    const lines = fixtureLines(deniedTurnFixture)

    // Act
    const transcript = replayLines(lines, startedTurn())

    // Assert
    const expected = [{ toolName: "Bash", summary: "touch denied-probe.txt", status: "denied" }]
    expect(
      entriesOfKind(transcript, "tool_activity").map(({ toolName, summary, status }) => ({
        toolName,
        summary,
        status,
      }))
    ).toEqual(expected)
  })

  it("a_denied_tool_adds_the_approval_notice", () => {
    // Arrange
    const lines = fixtureLines(deniedTurnFixture)

    // Act
    const transcript = replayLines(lines, startedTurn())

    // Assert
    const expected = ["Bash needed approval, and this chat cannot approve actions yet."]
    expect(entriesOfKind(transcript, "notice").map((entry) => entry.text)).toEqual(expected)
  })

  it("a_denied_tool_still_ends_the_turn_normally", () => {
    // Arrange
    const lines = fixtureLines(deniedTurnFixture)
    const resultLine = lines.at(-1) ?? ""

    // Act
    const events = parseClaudeStreamLine(resultLine)

    // Assert
    const expected = [{ kind: "turn_ended", outcome: "completed", message: null }]
    expect(events).toEqual(expected)
  })

  it("an_interrupted_turn_ends_as_interrupted", () => {
    // Arrange
    // The shape observed after a control_request interrupt (capture 07), trimmed to what is read.
    const interruptedResult = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      errors: ["[ede_diagnostic] result_type=user"],
      session_id: "<SESSION_ID>",
    })
    const transcript = startedTurn()

    // Act
    const interrupted = replayLines([interruptedResult], transcript)

    // Assert
    const expected = { turn: "idle", lastNotice: "Interrupted." }
    expect({
      turn: interrupted.turn,
      lastNotice: entriesOfKind(interrupted, "notice").at(-1)?.text,
    }).toEqual(expected)
  })

  it("unknown_and_malformed_lines_are_ignored_without_throwing", () => {
    // Arrange
    const ignoredLines = [
      "{not json",
      "",
      "42",
      "null",
      '{"type":"bogus"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
      '{"type":"system","subtype":"hook_started","hook_id":"h1"}',
      '{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":"x","delta":{"type":"text_delta","text":1}}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}',
      '{"type":"result"}',
    ]

    // Act
    const events = ignoredLines.flatMap((line) => parseClaudeStreamLine(line))

    // Assert
    expect(events).toEqual([])
  })

  it("text_from_a_subagent_inside_a_tool_call_stays_out_of_the_assistant_message", () => {
    // Arrange
    const subagentDelta = JSON.stringify({
      type: "stream_event",
      parent_tool_use_id: "toolu_09",
      api_message_id: "msg_09",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
    })

    // Act
    const events = parseClaudeStreamLine(subagentDelta)

    // Assert
    expect(events).toEqual([])
  })

  it("a_failed_turn_shows_the_reason_the_cli_gave", () => {
    // Arrange
    const reason = "Invalid API key · Please run /login"
    const failedResult = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: reason,
      api_error_status: 401,
      errors: ["[ede_diagnostic] internal detail"],
    })

    // Act
    const transcript = replayLines([failedResult], startedTurn())

    // Assert
    const expected = [`${reason} (API status 401)`]
    expect(entriesOfKind(transcript, "notice").map((entry) => entry.text)).toEqual(expected)
  })

  it("a_turn_that_hit_the_turn_limit_says_so", () => {
    // Arrange
    const maxTurnsResult = JSON.stringify({ type: "result", subtype: "error_max_turns" })

    // Act
    const transcript = replayLines([maxTurnsResult], startedTurn())

    // Assert
    const expected = ["Stopped after the maximum number of turns."]
    expect(entriesOfKind(transcript, "notice").map((entry) => entry.text)).toEqual(expected)
  })

  it("a_failed_turn_without_a_reason_shows_the_generic_notice", () => {
    // Arrange
    const bareFailure = JSON.stringify({ type: "result", subtype: "error_unknown_kind" })

    // Act
    const transcript = replayLines([bareFailure], startedTurn())

    // Assert
    const expected = ["The answer ended with an error."]
    expect(entriesOfKind(transcript, "notice").map((entry) => entry.text)).toEqual(expected)
  })

  it("a_tool_still_running_when_its_turn_ends_shows_as_stopped", () => {
    // Arrange
    const lines = fixtureLines(toolTurnFixture)
    const toolResultIndex = lines.findIndex((line) => lineType(line) === "user")
    const linesBeforeResult = lines.slice(0, toolResultIndex)
    const interruptedResult = JSON.stringify({ type: "result", subtype: "error_during_execution" })

    // Act
    const transcript = replayLines([...linesBeforeResult, interruptedResult], startedTurn())

    // Assert
    const expected = ["stopped"]
    expect(entriesOfKind(transcript, "tool_activity").map((entry) => entry.status)).toEqual(
      expected
    )
  })

  it("a_tool_still_running_when_the_process_ends_shows_as_stopped_and_the_turn_ends", () => {
    // Arrange
    const lines = fixtureLines(toolTurnFixture)
    const toolResultIndex = lines.findIndex((line) => lineType(line) === "user")
    const running = replayLines(lines.slice(0, toolResultIndex), startedTurn())

    // Act
    const transcript = applyChatEvents(running, [{ kind: "session_ended" }])

    // Assert
    const expected = { turn: "idle", statuses: ["stopped"] }
    expect({
      turn: transcript.turn,
      statuses: entriesOfKind(transcript, "tool_activity").map((entry) => entry.status),
    }).toEqual(expected)
  })
})

// A live run through the real native pipe (answer, denied touch, interrupted essay, answer).
describe("Claude stream-json live four-turn capture", () => {
  // Each turn starts with system/init, the reviewer's message is sent just before it.
  function replayTurns(lines: ReadonlyArray<string>): ChatTranscript {
    return lines.reduce((current: ChatTranscript, line) => {
      const isTurnStart = line.includes('"subtype":"init"')
      const withMessage = isTurnStart
        ? applyChatEvents(current, [{ kind: "user_message_sent", text: "Next question" }])
        : current
      return applyChatEvents(withMessage, parseClaudeStreamLine(line))
    }, EMPTY_CHAT_TRANSCRIPT)
  }

  it("ends_four_turns_in_order_with_the_third_interrupted", () => {
    // Arrange
    const lines = fixtureLines(deniedThenInterruptedFixture)

    // Act
    const outcomes = lines
      .flatMap((line) => parseClaudeStreamLine(line))
      .flatMap((event) => (event.kind === "turn_ended" ? [event.outcome] : []))

    // Assert
    const expected = ["completed", "completed", "interrupted", "completed"]
    expect(outcomes).toEqual(expected)
  })

  it("shows_the_denied_tool_row_and_exactly_one_approval_notice", () => {
    // Arrange
    const lines = fixtureLines(deniedThenInterruptedFixture)

    // Act
    const transcript = replayTurns(lines)

    // Assert
    const deniedTools = entriesOfKind(transcript, "tool_activity")
      .filter((entry) => entry.status === "denied")
      .map(({ toolName, summary }) => ({ toolName, summary }))
    const approvalNotices = entriesOfKind(transcript, "notice").filter((entry) =>
      entry.text.includes("needed approval")
    )
    expect(deniedTools).toEqual([{ toolName: "Bash", summary: "touch chat-denied-probe.txt" }])
    expect(approvalNotices).toHaveLength(1)
  })

  it("leaves_nothing_streaming_or_running_after_the_interrupted_turn", () => {
    // Arrange
    const lines = fixtureLines(deniedThenInterruptedFixture)
    const turnEnds = lines.flatMap((line, index) => (lineType(line) === "result" ? [index] : []))
    const linesThroughInterrupt = lines.slice(0, (turnEnds[2] ?? 0) + 1)

    // Act
    const transcript = replayTurns(linesThroughInterrupt)

    // Assert
    const expected = { turn: "idle", lastNotice: "Interrupted.", runningTools: [] }
    expect({
      turn: transcript.turn,
      lastNotice: entriesOfKind(transcript, "notice").at(-1)?.text,
      runningTools: entriesOfKind(transcript, "tool_activity").filter(
        (entry) => entry.status === "running"
      ),
    }).toEqual(expected)
  })

  it("answers_the_turn_after_the_interrupt", () => {
    // Arrange
    const lines = fixtureLines(deniedThenInterruptedFixture)

    // Act
    const transcript = replayTurns(lines)

    // Assert
    const expected = { kind: "assistant_message", text: "ok\n\nZXQ-7" }
    const lastEntry = transcript.entries.at(-1)
    expect({
      kind: lastEntry?.kind,
      text: lastEntry?.kind === "assistant_message" ? lastEntry.text : null,
    }).toEqual(expected)
  })
})
