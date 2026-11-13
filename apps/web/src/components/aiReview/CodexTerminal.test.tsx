import type { AnswerReport } from "@pr-visulizer/shared"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { TERMINAL_PROMPT_SHORTCUTS } from "@/entity/terminalPromptShortcuts"
import type { ReviewSnapshot } from "@/entity/terminalReviewSnapshot"

import type { CodexTerminalContext } from "@/service/terminal/codexTerminal"

import { CodexTerminal } from "./CodexTerminal"

const terminal = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
  paste: vi.fn(),
}))
const bridge = vi.hoisted(() => ({
  resolve: null as
    | ((value: {
        write: ReturnType<typeof vi.fn>
        resize: ReturnType<typeof vi.fn>
        updateContext: ReturnType<typeof vi.fn>
        stop: ReturnType<typeof vi.fn>
        dispose: ReturnType<typeof vi.fn>
      }) => void)
    | null,
  write: vi.fn(),
  start: vi.fn(),
}))

const answer = vi.hoisted(() => ({
  onReport: null as ((report: AnswerReport) => void) | null,
  unlisten: vi.fn(),
  show: vi.fn(),
}))

vi.hoisted(() => {
  ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24
    cols = 80
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    paste = terminal.paste
    onData(listener: (data: string) => void) {
      terminal.onData = listener
      listener("\u001b[?1;2c")
      return { dispose() {} }
    }
    dispose() {}
  },
}))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock("@/service/terminal/codexTerminal", () => ({
  startCodexTerminal: bridge.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        bridge.resolve = resolve
      })
  ),
}))
vi.mock("@/service/terminal/answerWindow", () => ({
  subscribeAnswerReports: (_sessionId: string, onReport: (report: AnswerReport) => void) => {
    answer.onReport = onReport
    return Promise.resolve(answer.unlisten)
  },
  showAnswerWindow: answer.show,
}))

function createBridgeSession() {
  return {
    write: bridge.write,
    resize: vi.fn().mockResolvedValue(undefined),
    updateContext: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

// The session waits for the reviewer, so every test that needs one presses Start first.
function pressStart(): void {
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
}

describe("CodexTerminal", () => {
  it("keeps_one_terminal_session_when_its_parent_rerenders_with_stable_callbacks", async () => {
    // Arrange
    bridge.start.mockClear()
    const onSessionStarted = vi.fn()
    const onSessionEnded = vi.fn()
    const props = {
      provider: "codex" as const,
      shortcuts: TERMINAL_PROMPT_SHORTCUTS,
      repositoryPath: "/repo",
      initialPrompt: "Review PR",
      model: "gpt-5.6-luna",
      terminalIdentity: "pr-42",
      onSessionStarted,
      onSessionEnded,
      context: {
        owner: "acme",
        repo: "web",
        number: 42,
        title: "PR",
        baseSha: "base",
        headSha: "head",
        selectedFilePath: null,
      },
    }
    const view = render(<CodexTerminal {...props} />)
    pressStart()

    // Act
    view.rerender(<CodexTerminal {...props} />)

    // Assert
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
  })

  it("forwards_an_early_terminal_query_after_the_session_starts", async () => {
    // Arrange
    bridge.write.mockClear()
    render(
      <CodexTerminal
        provider="codex"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model="gpt-5.6-luna"
        terminalIdentity="pr-42"
        onSessionStarted={() => {}}
        onSessionEnded={() => {}}
        context={{
          owner: "acme",
          repo: "web",
          number: 42,
          title: "PR",
          baseSha: "base",
          headSha: "head",
          selectedFilePath: null,
        }}
      />
    )
    pressStart()

    // Act
    bridge.resolve?.({
      write: bridge.write,
      resize: vi.fn().mockResolvedValue(undefined),
      updateContext: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    })

    // Assert
    await waitFor(() => expect(bridge.write).toHaveBeenCalledWith("\u001b[?1;2c"))
  })

  it("reopens_the_answer_window_for_the_session_after_the_agent_rendered_one", async () => {
    // Arrange
    const user = userEvent.setup()
    bridge.start.mockClear()
    answer.show.mockReset().mockResolvedValue(undefined)
    render(
      <CodexTerminal
        provider="codex"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model="gpt-5.6-luna"
        terminalIdentity="pr-42"
        onSessionStarted={() => {}}
        onSessionEnded={() => {}}
        context={{
          owner: "acme",
          repo: "web",
          number: 42,
          title: "PR",
          baseSha: "base",
          headSha: "head",
          selectedFilePath: null,
        }}
      />
    )
    pressStart()
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
    const startedSessionId = bridge.start.mock.calls[0]![0].sessionId as string
    act(() => bridge.resolve?.(createBridgeSession()))
    await screen.findByRole("button", { name: "Stop" })
    const buttonBeforeAnswer = screen.queryByRole("button", { name: "Open answer" })
    const renderedReport: AnswerReport = {
      version: 1,
      sessionId: startedSessionId,
      title: "Review summary",
      markdown: "Looks good.",
      fileRefs: [],
      updatedAt: "2026-10-14T08:00:00.000Z",
    }
    act(() => answer.onReport?.(renderedReport))

    // Act
    await user.click(screen.getByRole("button", { name: "Open answer" }))

    // Assert
    expect(buttonBeforeAnswer).not.toBeInTheDocument()
    expect(answer.show).toHaveBeenCalledWith(startedSessionId)
  })

  it("prefills_the_pr_description_prompt_into_the_terminal_input", async () => {
    // Arrange
    const user = userEvent.setup()
    terminal.paste.mockClear()
    const headSha = "head-sha-42"
    render(
      <CodexTerminal
        provider="codex"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model="gpt-5.6-luna"
        terminalIdentity="pr-42"
        onSessionStarted={() => {}}
        onSessionEnded={() => {}}
        context={{
          owner: "acme",
          repo: "web",
          number: 42,
          title: "PR",
          baseSha: "base-sha-42",
          headSha,
          selectedFilePath: null,
        }}
      />
    )
    pressStart()
    const shortcutButton = screen.getByRole("button", { name: "PR description" })
    const wasDisabledBeforeStart = shortcutButton.hasAttribute("disabled")
    act(() => bridge.resolve?.(createBridgeSession()))
    await waitFor(() => expect(shortcutButton).toBeEnabled())

    // Act
    await user.click(shortcutButton)

    // Assert
    const pastedPrompt = terminal.paste.mock.calls[0]?.[0] as string
    expect(wasDisabledBeforeStart).toBe(true)
    expect(terminal.paste).toHaveBeenCalledTimes(1)
    expect(pastedPrompt).toContain(headSha)
    expect(pastedPrompt).toContain("## System design")
  })

  it("groups_session_controls_apart_from_prompt_shortcuts", async () => {
    // Arrange
    render(
      <CodexTerminal
        provider="codex"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model="gpt-5.6-luna"
        terminalIdentity="pr-42"
        onSessionStarted={() => {}}
        onSessionEnded={() => {}}
        context={{
          owner: "acme",
          repo: "web",
          number: 42,
          title: "PR",
          baseSha: "base",
          headSha: "head",
          selectedFilePath: null,
        }}
      />
    )
    pressStart()

    // Act
    act(() => bridge.resolve?.(createBridgeSession()))
    const stopButton = await screen.findByRole("button", { name: "Stop" })

    // Assert
    const shortcutStrip = screen.getByRole("group", { name: "Prompt shortcuts" })
    const shortcutButton = within(shortcutStrip).getByRole("button", { name: "PR description" })
    expect(shortcutStrip).not.toContainElement(stopButton)
    expect(stopButton.parentElement).not.toBe(shortcutButton.parentElement)
  })

  it("does_not_start_a_session_until_start_is_pressed", async () => {
    // Arrange
    bridge.start.mockClear()
    render(
      <CodexTerminal
        provider="claude"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model={null}
        terminalIdentity="pr-42"
        onSessionStarted={() => {}}
        onSessionEnded={() => {}}
        context={{
          owner: "acme",
          repo: "web",
          number: 42,
          title: "PR",
          baseSha: "base",
          headSha: "head",
          selectedFilePath: null,
        }}
      />
    )
    const startCallsBeforePress = bridge.start.mock.calls.length
    const startButton = screen.getByRole("button", { name: "Start" })

    // Act
    fireEvent.click(startButton)

    // Assert
    expect(startCallsBeforePress).toBe(0)
    await waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
  })

  it("returns_to_idle_instead_of_relaunching_when_the_provider_changes", async () => {
    // Arrange
    bridge.start.mockClear()
    const onSessionStarted = () => {}
    const onSessionEnded = () => {}
    const context = {
      owner: "acme",
      repo: "web",
      number: 42,
      title: "PR",
      baseSha: "base",
      headSha: "head",
      selectedFilePath: null,
    }
    const codexSession = createBridgeSession()
    const view = render(
      <CodexTerminal
        provider="codex"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model={null}
        terminalIdentity="pr-42"
        onSessionStarted={onSessionStarted}
        onSessionEnded={onSessionEnded}
        context={context}
      />
    )
    pressStart()
    act(() => bridge.resolve?.(codexSession))
    await screen.findByRole("button", { name: "Stop" })

    // Act
    view.rerender(
      <CodexTerminal
        provider="claude"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model={null}
        terminalIdentity="pr-42"
        onSessionStarted={onSessionStarted}
        onSessionEnded={onSessionEnded}
        context={context}
      />
    )

    // Assert
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument()
    expect(bridge.start).toHaveBeenCalledTimes(1)
    expect(codexSession.stop).toHaveBeenCalledTimes(1)
  })

  it("reports_a_reviewer_stop_as_stopped_not_as_a_kill_signal", async () => {
    // Arrange
    const user = userEvent.setup()
    bridge.start.mockClear()
    render(
      <CodexTerminal
        provider="claude"
        shortcuts={TERMINAL_PROMPT_SHORTCUTS}
        repositoryPath="/repo"
        initialPrompt="Review PR"
        model={null}
        terminalIdentity="pr-42"
        onSessionStarted={() => {}}
        onSessionEnded={() => {}}
        context={{
          owner: "acme",
          repo: "web",
          number: 42,
          title: "PR",
          baseSha: "base",
          headSha: "head",
          selectedFilePath: null,
        }}
      />
    )
    pressStart()
    act(() => bridge.resolve?.(createBridgeSession()))
    const [startInput, handlers] = bridge.start.mock.calls[0]!
    const killSignalExit = {
      sessionId: startInput.sessionId as string,
      code: null,
      error: "Killed: 9",
    }

    // Act
    await user.click(await screen.findByRole("button", { name: "Stop" }))
    act(() => handlers.onExit(killSignalExit))

    // Assert
    expect(screen.getByRole("status")).toHaveTextContent("Stopped.")
  })

  it("pushes_the_review_snapshot_when_it_changes", async () => {
    // Arrange
    const baseContext: CodexTerminalContext = {
      owner: "acme",
      repo: "web",
      number: 42,
      title: "PR",
      baseSha: "base",
      headSha: "head",
      selectedFilePath: "src/app.ts",
    }
    const review: ReviewSnapshot = {
      queueMode: "foundations",
      selection: { path: "src/app.ts", startLine: 10, endLine: 11 },
      files: [
        {
          path: "src/app.ts",
          status: "modified",
          reviewed: false,
          suggestedNext: true,
          skipReason: null,
          diffOmitted: null,
        },
      ],
      drafts: [],
    }
    const contextWithReview: CodexTerminalContext = { ...baseContext, review }
    const session = createBridgeSession()
    const props = {
      provider: "codex" as const,
      shortcuts: TERMINAL_PROMPT_SHORTCUTS,
      repositoryPath: "/repo",
      initialPrompt: "Review PR",
      model: null,
      terminalIdentity: "pr-42",
      onSessionStarted: () => {},
      onSessionEnded: () => {},
    }
    const view = render(<CodexTerminal {...props} context={baseContext} />)
    pressStart()
    act(() => bridge.resolve?.(session))
    await screen.findByRole("button", { name: "Stop" })
    vi.useFakeTimers()

    try {
      // Act
      view.rerender(<CodexTerminal {...props} context={contextWithReview} />)
      act(() => vi.advanceTimersByTime(149))
      const lastPushJustBeforeDebounce = session.updateContext.mock.lastCall?.[0]
      act(() => vi.advanceTimersByTime(1))

      // Assert
      expect(lastPushJustBeforeDebounce).toEqual(baseContext)
      expect(session.updateContext).toHaveBeenLastCalledWith(contextWithReview)
    } finally {
      vi.useRealTimers()
    }
  })
})
