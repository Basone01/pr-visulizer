import type { AnswerReport } from "@pr-visulizer/shared"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { PR_CONTEXT_SENT_NOTICE } from "@/entity/aiChat/chatTranscript"
import { TERMINAL_PROMPT_SHORTCUTS } from "@/entity/terminalPromptShortcuts"
import type { ReviewSnapshot } from "@/entity/terminalReviewSnapshot"

import type { AiSessionContext } from "@/service/aiChat/chatSession"

import { AiChatSurface } from "./AiChatSurface"

type Listener = (event: { payload: unknown }) => void

// The Tauri boundary is the only thing mocked, so the real chat session wrapper,
// the Claude line adapter and the transcript reducer all run in these tests.
const tauri = vi.hoisted(() => {
  ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  return {
    listeners: new Map<string, Set<Listener>>(),
    invoke: vi.fn(),
  }
})

const blocks = vi.hoisted(() => ({
  renderCount: 0,
  canOpenFile: null as ((path: string) => boolean) | null,
}))
const mermaid = vi.hoisted(() => ({ render: vi.fn<(source: string) => Promise<string>>() }))

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, listener: Listener) => {
    const listeners = tauri.listeners.get(eventName) ?? new Set<Listener>()
    listeners.add(listener)
    tauri.listeners.set(eventName, listeners)
    return Promise.resolve(() => listeners.delete(listener))
  },
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))

// The OpenUI wrapper is owned by another slice, so a block is stubbed down to its two callbacks.
// It counts its renders and throws on BROKEN, standing in for a block chunk that fails to load.
vi.mock("@/components/openui/OpenUiBlock", () => ({
  default: (props: {
    code: string
    onOpenFile: (path: string, line: number | undefined) => void
    onFollowUp: (text: string) => void
    canOpenFile: (path: string) => boolean
  }) => {
    blocks.renderCount += 1
    blocks.canOpenFile = props.canOpenFile
    if (props.code.includes("BROKEN")) throw new Error("block chunk failed to load")

    return (
      <div role="group" aria-label="Review block">
        <pre>{props.code}</pre>
        <button type="button" onClick={() => props.onFollowUp("Explain the riskiest change")}>
          Ask follow-up
        </button>
        <button type="button" onClick={() => openCitedFile(props.code, props.onOpenFile)}>
          Open cited file
        </button>
      </div>
    )
  },
}))
// Stands in for a FileRef("path", line) in a block, which reaches the surface as onOpenFile.
function openCitedFile(
  code: string,
  onOpenFile: (path: string, line: number | undefined) => void
): void {
  const fileRef = /FileRef\("([^"]+)", (\d+)/.exec(code)
  if (fileRef?.[1] !== undefined) onOpenFile(fileRef[1], Number(fileRef[2]))
}

// mermaid needs real SVG layout, so its wrapper is mocked at the module boundary.
vi.mock("@/utils/markdown/mermaidRenderer", () => ({ renderMermaidSvg: mermaid.render }))
vi.mock("@/components/openui/reviewUiPrompt", () => ({
  buildReviewUiPrompt: () => REVIEW_UI_PROMPT,
}))

const REVIEW_UI_PROMPT = "Use the review component library."
const INITIAL_PROMPT = "You are helping review PR 42."

const CONTEXT: AiSessionContext = {
  owner: "acme",
  repo: "webapp",
  number: 42,
  title: "Add retries",
  baseSha: "base-sha",
  headSha: "head-sha",
  selectedFilePath: "src/app.ts",
}

// The PR's own files: only these are clickable in the chat, because a click jumps the diff.
const REVIEW: ReviewSnapshot = {
  queueMode: "foundations",
  selection: null,
  files: [{ path: "src/app.ts", status: "modified", reviewed: false, suggestedNext: false }],
  drafts: [],
}

const CONTEXT_WITH_PR_FILES: AiSessionContext = { ...CONTEXT, review: REVIEW }

type SurfaceProps = ComponentProps<typeof AiChatSurface>

function surfaceProps(overrides: Partial<SurfaceProps> = {}): SurfaceProps {
  return {
    provider: "claude",
    shortcuts: TERMINAL_PROMPT_SHORTCUTS,
    repositoryPath: "/repo",
    initialPrompt: INITIAL_PROMPT,
    model: "haiku",
    terminalIdentity: "acme/webapp#42:base-sha:head-sha",
    onSessionStarted: vi.fn(),
    onSessionEnded: vi.fn(),
    context: CONTEXT,
    ...overrides,
  }
}

function requestsOf(command: string): Array<Record<string, unknown>> {
  return tauri.invoke.mock.calls
    .filter(([invokedCommand]) => invokedCommand === command)
    .map(([, args]) => (args as { request: Record<string, unknown> }).request)
}

function emit(eventName: string, payload: unknown): void {
  for (const listener of tauri.listeners.get(eventName) ?? []) listener({ payload })
}

function emitLine(sessionId: string, line: object): void {
  emit("ai-chat://line", { sessionId, sequence: 0, line: JSON.stringify(line) })
}

function textDelta(text: string): object {
  return {
    type: "stream_event",
    api_message_id: "msg_01",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  }
}

const TURN_RESULT = { type: "result", subtype: "success", is_error: false, result: "ignored" }

// Presses Start and waits until the first turn (the PR context) has been sent.
async function startChat(user: ReturnType<typeof userEvent.setup>): Promise<string> {
  await user.click(screen.getByRole("button", { name: "Start" }))
  await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(1))
  return String(requestsOf("ai_chat_start")[0]?.sessionId)
}

async function startChatWithIdleTurn(user: ReturnType<typeof userEvent.setup>): Promise<string> {
  const sessionId = await startChat(user)
  emitLine(sessionId, TURN_RESULT)
  await screen.findByRole("button", { name: "Send" })
  return sessionId
}

// The approval wording is the reducer's, the surface only has to show it.
const APPROVAL_NOTICE = "Bash needed approval, and this chat cannot approve actions yet."

function toolStart(toolCallId: string, name: string): object {
  return {
    type: "stream_event",
    api_message_id: "msg_01",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolCallId, name, input: {} },
    },
  }
}

function transcriptLog(): HTMLElement {
  return screen.getByRole("log", { name: "Chat transcript" })
}

beforeEach(() => {
  tauri.listeners.clear()
  tauri.invoke.mockReset()
  tauri.invoke.mockResolvedValue(undefined)
  blocks.renderCount = 0
  blocks.canOpenFile = null
  mermaid.render.mockReset()
  mermaid.render.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>')
})

describe("AiChatSurface", () => {
  it("does_not_start_a_chat_session_until_start_is_pressed", async () => {
    // Arrange
    render(<AiChatSurface {...surfaceProps()} />)

    // Act
    await screen.findByText("Press Start to chat with Claude.")

    // Assert
    expect(requestsOf("ai_chat_start")).toEqual([])
  })

  it("start_sends_the_review_ui_prompt_as_the_system_prompt", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)

    // Act
    const sessionId = await startChat(user)

    // Assert
    const expected = {
      sessionId,
      provider: "claude",
      repositoryPath: "/repo",
      model: "haiku",
      systemPromptAppend: REVIEW_UI_PROMPT,
      context: CONTEXT,
    }
    expect(requestsOf("ai_chat_start")).toEqual([expected])
  })

  it("start_sends_the_pr_context_as_the_first_turn_and_shows_it_as_a_notice", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSessionStarted = vi.fn()
    render(<AiChatSurface {...surfaceProps({ onSessionStarted })} />)

    // Act
    const sessionId = await startChat(user)

    // Assert
    expect(requestsOf("ai_chat_send")).toEqual([{ sessionId, text: INITIAL_PROMPT }])
    expect(onSessionStarted).toHaveBeenCalledWith(sessionId)
    expect(screen.getByText(PR_CONTEXT_SENT_NOTICE)).toBeInTheDocument()
    expect(screen.queryByText(INITIAL_PROMPT)).not.toBeInTheDocument()
  })

  it("renders_a_streamed_message_once", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)

    // Act
    emitLine(sessionId, textDelta("The PR adds "))
    emitLine(sessionId, textDelta("retries."))
    emitLine(sessionId, TURN_RESULT)

    // Assert
    expect(await screen.findByText("The PR adds retries.")).toBeInTheDocument()
    expect(screen.queryByText("ignored")).not.toBeInTheDocument()
  })

  it("a_shortcut_prefills_the_composer_without_sending", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const shortcut = TERMINAL_PROMPT_SHORTCUTS[0]!
    const composer = screen.getByRole("textbox", { name: "Message Claude" })

    // Act
    await user.click(screen.getByRole("button", { name: shortcut.label }))

    // Assert
    const expectedText = shortcut.buildPrompt({
      prUrl: "https://github.com/acme/webapp/pull/42",
      title: CONTEXT.title,
      baseSha: CONTEXT.baseSha,
      headSha: CONTEXT.headSha,
      selectedFile: CONTEXT.selectedFilePath,
    })
    expect(composer).toHaveValue(expectedText)
    expect(composer).toHaveFocus()
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
  })

  it("enter_sends_the_message", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChatWithIdleTurn(user)
    const question = "What does the retry loop do?"

    // Act
    await user.type(screen.getByRole("textbox", { name: "Message Claude" }), `${question}{Enter}`)

    // Assert
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(2))
    expect(requestsOf("ai_chat_send")[1]).toEqual({ sessionId, text: question })
    expect(screen.getByText(question)).toBeInTheDocument()
  })

  it("shift_enter_adds_a_newline_instead_of_sending", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const composer = screen.getByRole("textbox", { name: "Message Claude" })

    // Act
    await user.type(composer, "first line{Shift>}{Enter}{/Shift}second line")

    // Assert
    expect(composer).toHaveValue("first line\nsecond line")
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
  })

  it("interrupt_replaces_send_while_a_turn_runs_and_calls_the_interrupt_command", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)

    // Act
    await user.click(screen.getByRole("button", { name: "Interrupt" }))

    // Assert
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument()
    expect(requestsOf("ai_chat_interrupt")).toEqual([{ sessionId }])
  })

  it("a_link_to_a_pr_file_jumps_the_diff_for_this_session", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("The retry is in [src/app.ts:3](src/app.ts#L3)."))
    emitLine(sessionId, TURN_RESULT)

    // Act
    await user.click(await screen.findByRole("button", { name: "src/app.ts:3" }))

    // Assert
    const expected = [{ sessionId, path: "src/app.ts", line: 3 }]
    expect(requestsOf("codex_answer_window_open_file")).toEqual(expected)
  })

  it("a_follow_up_from_a_block_lands_in_the_composer_without_sending", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("Summary:\n```openui-lang\nroot = Card()\n```"))
    emitLine(sessionId, TURN_RESULT)

    // Act
    await user.click(await screen.findByRole("button", { name: "Ask follow-up" }))

    // Assert
    expect(screen.getByRole("textbox", { name: "Message Claude" })).toHaveValue(
      "Explain the riskiest change"
    )
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
  })

  it("changing_the_selected_file_pushes_context_without_restarting_the_session", async () => {
    // Arrange
    const user = userEvent.setup()
    const props = surfaceProps()
    const { rerender } = render(<AiChatSurface {...props} />)
    const sessionId = await startChat(user)
    const nextContext = { ...CONTEXT, selectedFilePath: "src/retry.ts" }

    // Act
    rerender(<AiChatSurface {...props} context={nextContext} />)

    // Assert
    await waitFor(() =>
      expect(requestsOf("codex_terminal_update_context")).toContainEqual({
        sessionId,
        context: nextContext,
      })
    )
    expect(requestsOf("ai_chat_start")).toHaveLength(1)
    expect(requestsOf("ai_chat_stop")).toEqual([])
  })

  it("changing_the_pr_ends_the_session_and_starts_one_for_the_new_pr", async () => {
    // Arrange
    const user = userEvent.setup()
    const props = surfaceProps()
    const { rerender } = render(<AiChatSurface {...props} />)
    const firstSessionId = await startChat(user)
    const nextPrIdentity = "acme/webapp#43:base-2:head-2"

    // Act
    rerender(<AiChatSurface {...props} terminalIdentity={nextPrIdentity} />)

    // Assert
    await waitFor(() => expect(requestsOf("ai_chat_start")).toHaveLength(2))
    expect(requestsOf("ai_chat_stop")).toEqual([{ sessionId: firstSessionId }])
  })

  it("a_model_change_returns_to_idle_without_relaunching", async () => {
    // Arrange
    const user = userEvent.setup()
    const props = surfaceProps()
    const { rerender } = render(<AiChatSurface {...props} />)
    const sessionId = await startChat(user)

    // Act
    rerender(<AiChatSurface {...props} model="opus" />)

    // Assert
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument()
    expect(requestsOf("ai_chat_stop")).toEqual([{ sessionId }])
    expect(requestsOf("ai_chat_start")).toHaveLength(1)
  })

  it("reports_a_reviewer_stop_as_stopped_not_as_a_kill_signal", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)

    // Act
    await user.click(screen.getByRole("button", { name: "Stop" }))
    emit("ai-chat://exit", { sessionId, code: null, error: "terminated by signal 15" })

    // Assert
    expect(await screen.findByText("Stopped.")).toBeInTheDocument()
    expect(screen.queryByText("terminated by signal 15")).not.toBeInTheDocument()
  })

  it("unmounting_the_chat_stops_its_session", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSessionEnded = vi.fn()
    const { unmount } = render(<AiChatSurface {...surfaceProps({ onSessionEnded })} />)
    const sessionId = await startChat(user)

    // Act
    unmount()

    // Assert
    await waitFor(() => expect(requestsOf("ai_chat_stop")).toEqual([{ sessionId }]))
    expect(onSessionEnded).toHaveBeenCalledWith(sessionId)
  })

  it("asks_to_link_the_repository_before_starting", async () => {
    // Arrange
    render(<AiChatSurface {...surfaceProps({ repositoryPath: null })} />)

    // Act
    const message = await screen.findByRole("alert")

    // Assert
    expect(message).toHaveTextContent("Link this repository before starting Claude.")
  })

  it("enter_while_composing_an_ime_candidate_does_not_send", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const typedText = "こんにちは"
    fireEvent.change(composer, { target: { value: typedText } })

    // Act
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true })

    // Assert
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
    expect(composer).toHaveValue(typedText)
  })

  it("the_webkit_ime_enter_with_key_code_229_does_not_send", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const typedText = "日本語"
    fireEvent.change(composer, { target: { value: typedText } })

    // Act
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229, isComposing: false })

    // Assert
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
    expect(composer).toHaveValue(typedText)
  })

  it("a_message_typed_during_a_running_turn_is_kept_in_the_composer", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChat(user)
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const earlyQuestion = "And the tests?"

    // Act
    await user.type(composer, `${earlyQuestion}{Enter}`)

    // Assert
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
    expect(composer).toHaveValue(earlyQuestion)
  })

  it("a_follow_up_from_a_block_is_added_after_what_the_reviewer_typed", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("Summary:\n```openui-lang\nroot = Card()\n```"))
    emitLine(sessionId, TURN_RESULT)
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const typedText = "My own question"
    await user.type(composer, typedText)

    // Act
    await user.click(await screen.findByRole("button", { name: "Ask follow-up" }))

    // Assert
    expect(composer).toHaveValue(`${typedText}\nExplain the riskiest change`)
  })

  it("a_shortcut_is_added_after_what_the_reviewer_typed", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const shortcut = TERMINAL_PROMPT_SHORTCUTS[0]!
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const typedText = "Before that:"
    await user.type(composer, typedText)

    // Act
    await user.click(screen.getByRole("button", { name: shortcut.label }))

    // Assert
    expect(String((composer as HTMLTextAreaElement).value)).toMatch(new RegExp(`^${typedText}\n`))
  })

  it("a_rejected_send_keeps_the_session_and_returns_the_text_to_the_composer", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const rejection = "stdin is closed"
    tauri.invoke.mockImplementation((command: string) =>
      command === "ai_chat_send" ? Promise.reject(new Error(rejection)) : Promise.resolve()
    )
    const question = "Is the retry bounded?"

    // Act
    await user.type(screen.getByRole("textbox", { name: "Message Claude" }), `${question}{Enter}`)

    // Assert
    expect(await screen.findByText(`The message was not sent: ${rejection}`)).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Message Claude" })).toHaveValue(question)
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
  })

  it("a_message_over_the_size_limit_is_kept_and_explained_instead_of_sent", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const oversizedText = "a".repeat(256 * 1024 + 1)
    fireEvent.change(composer, { target: { value: oversizedText } })

    // Act
    fireEvent.keyDown(composer, { key: "Enter" })

    // Assert
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
    expect(composer).toHaveValue(oversizedText)
    expect(screen.getByRole("alert")).toHaveTextContent("The message is too long to send.")
  })

  it("open_answer_appears_after_the_agent_renders_one_and_reopens_it", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const buttonBeforeAnswer = screen.queryByRole("button", { name: "Open answer" })
    const renderedReport: AnswerReport = {
      version: 1,
      sessionId,
      title: "Review summary",
      markdown: "Looks good.",
      fileRefs: [],
      updatedAt: "2026-11-12T08:00:00.000Z",
    }
    emit("codex-answer://updated", renderedReport)

    // Act
    await user.click(await screen.findByRole("button", { name: "Open answer" }))

    // Assert
    expect(buttonBeforeAnswer).not.toBeInTheDocument()
    expect(requestsOf("codex_answer_window_show")).toEqual([{ sessionId }])
  })

  it("restart_after_an_exit_starts_a_new_session_without_stopping_the_gone_one", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const firstSessionId = await startChat(user)
    emit("ai-chat://exit", { sessionId: firstSessionId, code: 1, error: "claude crashed" })

    // Act
    await user.click(await screen.findByRole("button", { name: "Restart" }))

    // Assert
    await waitFor(() => expect(requestsOf("ai_chat_start")).toHaveLength(2))
    expect(requestsOf("ai_chat_start")[1]?.sessionId).not.toBe(firstSessionId)
    expect(requestsOf("ai_chat_stop")).toEqual([])
  })

  it("a_denied_tool_shows_a_denied_row_and_the_approval_notice", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const toolCallId = "toolu_01"

    // Act
    emitLine(sessionId, toolStart(toolCallId, "Bash"))
    emitLine(sessionId, {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: toolCallId,
    })

    // Assert
    const log = transcriptLog()
    expect(await within(log).findByText("Denied")).toBeInTheDocument()
    expect(within(log).getByText(APPROVAL_NOTICE)).toBeInTheDocument()
  })

  it("a_tool_left_running_reads_stopped_after_the_chat_exits", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, toolStart("toolu_02", "Bash"))
    await within(transcriptLog()).findByText("Running")

    // Act
    emit("ai-chat://exit", { sessionId, code: 1, error: "claude crashed" })

    // Assert
    expect(await within(transcriptLog()).findByText("Stopped")).toBeInTheDocument()
    expect(within(transcriptLog()).queryByText("Running")).not.toBeInTheDocument()
  })

  it("a_block_that_fails_to_load_still_shows_its_source", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const blockCode = 'root = Card("BROKEN")'
    vi.spyOn(console, "error").mockImplementation(() => {})

    // Act
    emitLine(sessionId, textDelta(`Summary:\n\`\`\`openui-lang\n${blockCode}\n\`\`\``))
    emitLine(sessionId, TURN_RESULT)

    // Assert
    const fallback = await screen.findByRole("alert")
    expect(fallback).toHaveTextContent("This block could not be shown.")
    expect(within(fallback).getByText(blockCode)).toBeInTheDocument()
  })

  it("a_new_review_snapshot_with_the_same_files_does_not_rerender_the_transcript", async () => {
    // Arrange
    const user = userEvent.setup()
    const review: ReviewSnapshot = {
      queueMode: "foundations",
      selection: null,
      files: [{ path: "src/app.ts", status: "modified", reviewed: false, suggestedNext: false }],
      drafts: [],
    }
    const props = surfaceProps({ context: { ...CONTEXT, review } })
    const { rerender } = render(<AiChatSurface {...props} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("Summary:\n```openui-lang\nroot = Card()\n```"))
    emitLine(sessionId, TURN_RESULT)
    await screen.findByRole("group", { name: "Review block" })
    const rendersBefore = blocks.renderCount
    const nextReview: ReviewSnapshot = {
      ...review,
      selection: { path: "src/app.ts", startLine: 3, endLine: 4 },
      files: review.files.map((file) => ({ ...file })),
    }

    // Act
    rerender(<AiChatSurface {...props} context={{ ...CONTEXT, review: nextReview }} />)

    // Assert
    expect(blocks.renderCount).toBe(rendersBefore)
  })

  it("a_chat_message_never_makes_the_webview_fetch_an_image", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const altText = "status"

    // Act
    emitLine(sessionId, textDelta(`Done. ![${altText}](https://tracker.example/p.png?d=SECRET)`))
    emitLine(sessionId, TURN_RESULT)

    // Assert
    expect(await within(transcriptLog()).findByText(new RegExp(altText))).toBeInTheDocument()
    expect(container.querySelector("img")).toBeNull()
  })

  it("a_chat_message_link_opens_only_https", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)

    // Act
    emitLine(
      sessionId,
      textDelta(
        "See [plain](http://attacker.example/login), [mail](mailto:a@b.example) and [docs](https://docs.example)."
      )
    )
    emitLine(sessionId, TURN_RESULT)

    // Assert
    const log = transcriptLog()
    expect(
      await within(log).findByRole("link", { name: "docs (docs.example)" })
    ).toBeInTheDocument()
    expect(within(log).queryByRole("link", { name: /^plain/ })).not.toBeInTheDocument()
    expect(within(log).queryByRole("link", { name: /^mail/ })).not.toBeInTheDocument()
  })

  it("a_mermaid_fence_in_a_chat_message_stays_code_and_never_runs_mermaid", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const diagram = 'flowchart TD\n  A@{ "img": "https:\\/\\/attacker.example/leak.png" }'

    // Act
    emitLine(sessionId, textDelta(`\`\`\`mermaid\n${diagram}\n\`\`\``))
    emitLine(sessionId, TURN_RESULT)

    // Assert
    const code = await within(transcriptLog()).findByText(/attacker\.example/)
    expect(code.closest("pre")).not.toBeNull()
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it("the_chat_is_not_offered_for_a_provider_without_one", async () => {
    // Arrange
    render(<AiChatSurface {...surfaceProps({ provider: "codex", model: null })} />)

    // Act
    const message = await screen.findByRole("alert")

    // Assert
    expect(message).toHaveTextContent("The chat is not available for Codex.")
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument()
  })

  it("a_failed_turns_reason_is_shown_as_plain_bounded_text", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const longReason = `**bold** [click](https://evil.example) ${"A".repeat(5000)}`
    const failedResult = { type: "result", subtype: "success", is_error: true, result: longReason }

    // Act
    emitLine(sessionId, failedResult)

    // Assert
    const log = transcriptLog()
    const notice = await within(log).findByText(/^\*\*bold\*\*/)
    expect(notice.textContent?.length).toBeLessThanOrEqual(2001)
    expect(notice.textContent?.endsWith("…")).toBe(true)
    expect(log.querySelector("strong, a")).toBeNull()
  })

  it("an_exit_right_after_start_keeps_the_exit_reason", async () => {
    // Arrange
    const user = userEvent.setup()
    let rejectInitialSend: (error: Error) => void = () => {}
    tauri.invoke.mockImplementation((command: string) =>
      command === "ai_chat_send"
        ? new Promise((_resolve, reject) => {
            rejectInitialSend = reject
          })
        : Promise.resolve()
    )
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const exitReason = "Not logged in. Run claude login."
    emit("ai-chat://exit", { sessionId, code: 1, error: exitReason })
    await screen.findByText(exitReason)

    // Act
    await act(async () => rejectInitialSend(new Error("chat session is no longer active")))

    // Assert
    expect(screen.getByText(exitReason)).toBeInTheDocument()
    expect(screen.queryByText("chat session is no longer active")).not.toBeInTheDocument()
  })

  // The probe's steps: focus the block button, press Enter, the click moves focus to the composer,
  // then the held key repeats there.
  it("a_held_enter_on_a_block_follow_up_button_does_not_send", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("Summary:\n```openui-lang\nroot = Card()\n```"))
    emitLine(sessionId, TURN_RESULT)
    const followUpButton = await screen.findByRole("button", { name: "Ask follow-up" })
    followUpButton.focus()
    fireEvent.keyDown(followUpButton, { key: "Enter" })
    fireEvent.click(followUpButton)

    // Act
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter", repeat: true })

    // Assert
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    expect(composer).toHaveFocus()
    expect(composer).toHaveValue("Explain the riskiest change")
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
  })

  it("a_fresh_enter_in_the_composer_after_a_follow_up_sends_it", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("Summary:\n```openui-lang\nroot = Card()\n```"))
    emitLine(sessionId, TURN_RESULT)
    await user.click(await screen.findByRole("button", { name: "Ask follow-up" }))
    const composer = screen.getByRole("textbox", { name: "Message Claude" })

    // Act
    fireEvent.keyDown(composer, { key: "Enter", repeat: false })

    // Assert
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(2))
    expect(requestsOf("ai_chat_send")[1]).toEqual({
      sessionId,
      text: "Explain the riskiest change",
    })
  })

  it("a_link_to_a_path_outside_the_pr_is_plain_text_and_opens_nothing", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    const outsidePath = "lib/commonentity/filter.go:103"

    // Act
    emitLine(sessionId, textDelta(`See [${outsidePath}](lib/commonentity/filter.go#L103).`))
    emitLine(sessionId, TURN_RESULT)

    // Assert
    const log = transcriptLog()
    expect(await within(log).findByText(outsidePath)).toBeInTheDocument()
    expect(within(log).queryByRole("button", { name: outsidePath })).not.toBeInTheDocument()
    expect(
      within(log).queryByRole("link", { name: new RegExp(outsidePath) })
    ).not.toBeInTheDocument()
  })

  it("a_file_ref_from_a_block_with_a_path_outside_the_pr_opens_nothing", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    emitLine(
      sessionId,
      textDelta('Here:\n```openui-lang\nroot = FileRef("lib/outside.go", 7, "x")\n```')
    )
    emitLine(sessionId, TURN_RESULT)

    // Act
    await user.click(await screen.findByRole("button", { name: "Open cited file" }))

    // Assert
    expect(requestsOf("codex_answer_window_open_file")).toEqual([])
  })

  it("a_block_is_told_which_files_it_can_open", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    emitLine(sessionId, textDelta("Here:\n```openui-lang\nroot = Card("))
    await screen.findByRole("group", { name: "Review block" })
    const canOpenFileWhileStreaming = blocks.canOpenFile

    // Act
    emitLine(sessionId, textDelta(")\n```"))
    emitLine(sessionId, TURN_RESULT)
    // The block has re-rendered with the finished code, so its props are the newest ones.
    await screen.findByText("root = Card()")

    // Assert
    const canOpenFile = blocks.canOpenFile
    const expected = { prFile: true, dotPrefixedPrFile: true, outsidePath: false, stable: true }
    expect({
      prFile: canOpenFile?.("src/app.ts"),
      dotPrefixedPrFile: canOpenFile?.("./src/app.ts"),
      outsidePath: canOpenFile?.("lib/outside.go"),
      stable: canOpenFile === canOpenFileWhileStreaming,
    }).toEqual(expected)
  })

  it("a_file_ref_from_a_block_with_a_pr_file_opens_it_at_its_line", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    emitLine(
      sessionId,
      textDelta('Here:\n```openui-lang\nroot = FileRef("src/app.ts", 7, "app")\n```')
    )
    emitLine(sessionId, TURN_RESULT)

    // Act
    await user.click(await screen.findByRole("button", { name: "Open cited file" }))

    // Assert
    const expected = [{ sessionId, path: "src/app.ts", line: 7 }]
    expect(requestsOf("codex_answer_window_open_file")).toEqual(expected)
  })
})

describe("AiChatSurface inline answers", () => {
  function answerReport(sessionId: string, overrides: Partial<AnswerReport> = {}): AnswerReport {
    return {
      version: 1,
      sessionId,
      title: "Review summary",
      markdown: "The retry loop is bounded.",
      fileRefs: [{ path: "src/app.ts", line: 12, label: "retry loop" }],
      updatedAt: "2026-11-12T08:00:00.000Z",
      ...overrides,
    }
  }

  it("an_answer_the_agent_renders_shows_inline_in_the_chat_with_its_title", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    const report = answerReport(sessionId)

    // Act
    emit("codex-answer://updated", report)

    // Assert
    const log = transcriptLog()
    expect(await within(log).findByRole("heading", { name: report.title })).toBeInTheDocument()
    expect(within(log).getByText(report.markdown)).toBeInTheDocument()
  })

  it("a_file_reference_in_an_answer_opens_that_file_at_its_line", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    emit("codex-answer://updated", answerReport(sessionId))

    // Act
    await user.click(await screen.findByRole("button", { name: "retry loop:12" }))

    // Assert
    const expected = [{ sessionId, path: "src/app.ts", line: 12 }]
    expect(requestsOf("codex_answer_window_open_file")).toEqual(expected)
  })

  it("a_file_reference_in_an_answer_outside_the_pr_is_plain_text", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    const fileRefs = [{ path: "lib/outside.go", line: 3 }]

    // Act
    emit("codex-answer://updated", answerReport(sessionId, { fileRefs }))

    // Assert
    const files = await within(transcriptLog()).findByRole("list", { name: "Referenced files" })
    expect(within(files).getByText("lib/outside.go:3")).toBeInTheDocument()
    expect(within(files).queryByRole("button")).not.toBeInTheDocument()
  })

  it("a_mermaid_block_in_an_answer_stays_code_and_an_image_in_it_does_not_load", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const markdown =
      "![pixel](https://tracker.example/p.png)\n\n```mermaid\nflowchart TD\n  A --> B\n```"

    // Act
    emit("codex-answer://updated", answerReport(sessionId, { markdown, fileRefs: [] }))

    // Assert
    const code = await within(transcriptLog()).findByText(/flowchart TD/)
    expect(code.closest("pre")).not.toBeNull()
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.querySelector("img")).toBeNull()
  })

  it("two_reports_give_two_answer_entries_in_order", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChat(user)
    const firstTitle = "First pass"
    const secondTitle = "Second pass"

    // Act
    emit("codex-answer://updated", answerReport(sessionId, { title: firstTitle }))
    emit("codex-answer://updated", answerReport(sessionId, { title: secondTitle }))

    // Assert
    await within(transcriptLog()).findByRole("heading", { name: secondTitle })
    const headings = within(transcriptLog())
      .getAllByRole("heading")
      .map((heading) => heading.textContent)
    expect(headings).toEqual([firstTitle, secondTitle])
  })

  it("a_referenced_file_label_that_already_ends_with_its_line_shows_the_line_once", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps({ context: CONTEXT_WITH_PR_FILES })} />)
    const sessionId = await startChat(user)
    const fileRefs = [
      { path: "src/app.ts", line: 47, label: "campaign_action.go:47" },
      { path: "src/app.ts", line: 12, label: "retry loop" },
    ]

    // Act
    emit("codex-answer://updated", answerReport(sessionId, { fileRefs }))

    // Assert
    const files = await within(transcriptLog()).findByRole("list", { name: "Referenced files" })
    const expected = ["campaign_action.go:47", "retry loop:12"]
    expect(
      within(files)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(expected)
  })

  it("an_answer_for_another_session_is_ignored", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChat(user)
    const otherSessionReport = answerReport("another-session", { title: "Not ours" })

    // Act
    emit("codex-answer://updated", otherSessionReport)

    // Assert
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(1))
    expect(within(transcriptLog()).queryByRole("heading")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open answer" })).not.toBeInTheDocument()
  })
})

// jsdom does no layout, so the log's geometry is set by hand and the ResizeObserver is a stub
// the test fires itself, standing in for a panel drag that changes the transcript's size.
describe("AiChatSurface scroll position across a resize", () => {
  const resize = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }))

  class ResizeObserverSpy {
    constructor(callback: () => void) {
      resize.callbacks.push(callback)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  type LogGeometry = { scrollTop: number; scrollHeight: number; clientHeight: number }

  function setLogGeometry(log: HTMLElement, geometry: LogGeometry): void {
    let scrollTop = geometry.scrollTop
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: geometry.scrollHeight })
    Object.defineProperty(log, "clientHeight", { configurable: true, value: geometry.clientHeight })
  }

  // Where a box sits in the transcript's content, measured from the content's top.
  type ContentBox = { top: number; height: number }

  // The log's own box stays at the viewport top (jsdom's 0), so a box's viewport top is its
  // content top minus the scroll. The box is read on every call, so a test can reflow it.
  function placeInTranscript(log: HTMLElement, element: HTMLElement, box: ContentBox): void {
    element.getBoundingClientRect = () => {
      const top = box.top - log.scrollTop
      return {
        top,
        bottom: top + box.height,
        left: 0,
        right: 100,
        width: 100,
        height: box.height,
      } as DOMRect
    }
  }

  function fireResize(): void {
    act(() => resize.callbacks.at(-1)?.())
  }

  beforeEach(() => {
    resize.callbacks.length = 0
    vi.stubGlobal("ResizeObserver", ResizeObserverSpy)
    return () => vi.unstubAllGlobals()
  })

  it("a_transcript_at_the_bottom_stays_at_the_bottom_after_a_resize", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const log = transcriptLog()
    setLogGeometry(log, { scrollTop: 200, scrollHeight: 300, clientHeight: 100 })
    fireEvent.scroll(log)
    const reflowedScrollHeight = 500

    // Act
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: reflowedScrollHeight })
    fireResize()

    // Assert
    const expected = reflowedScrollHeight
    expect(log.scrollTop).toBe(expected)
  })

  it("a_transcript_scrolled_up_keeps_the_entry_it_was_reading_in_place_after_a_resize", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    await startChatWithIdleTurn(user)
    const log = transcriptLog()
    const readEntry = within(log).getAllByRole("listitem")[0]!
    setLogGeometry(log, { scrollTop: 150, scrollHeight: 600, clientHeight: 100 })
    const readEntryBox: ContentBox = { top: 120, height: 80 }
    placeInTranscript(log, readEntry, readEntryBox)
    fireEvent.scroll(log)
    const entryTopAfterReflow = 200

    // Act
    readEntryBox.top = entryTopAfterReflow
    fireResize()

    // Assert
    const expected = 230
    expect(log.scrollTop).toBe(expected)
  })

  it("a_long_message_keeps_the_paragraph_it_was_reading_in_place_after_a_resize", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<AiChatSurface {...surfaceProps()} />)
    const sessionId = await startChatWithIdleTurn(user)
    const readText = "The paragraph being read."
    emitLine(sessionId, textDelta(`An opening paragraph.\n\n${readText}`))
    emitLine(sessionId, TURN_RESULT)
    const log = transcriptLog()
    const readParagraph = await within(log).findByText(readText)
    setLogGeometry(log, { scrollTop: 1150, scrollHeight: 3000, clientHeight: 100 })
    // Every box from the entry down to the paragraph spans the whole entry.
    const longEntryBox: ContentBox = { top: 100, height: 2000 }
    for (
      let box = readParagraph.parentElement;
      box !== null && box !== log;
      box = box.parentElement
    )
      placeInTranscript(log, box, longEntryBox)
    const readParagraphBox: ContentBox = { top: 1100, height: 200 }
    placeInTranscript(log, readParagraph, readParagraphBox)
    fireEvent.scroll(log)
    // A narrower panel makes the text above the paragraph taller, the entry's top stays put.
    const paragraphTopAfterReflow = 1600

    // Act
    readParagraphBox.top = paragraphTopAfterReflow
    fireResize()

    // Assert
    const expected = 1650
    expect(log.scrollTop).toBe(expected)
  })
})
