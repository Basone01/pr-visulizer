import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { CodexTerminal } from "./CodexTerminal"

const terminal = vi.hoisted(() => ({ onData: null as ((data: string) => void) | null }))
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

describe("CodexTerminal", () => {
  it("keeps_one_terminal_session_when_its_parent_rerenders_with_stable_callbacks", async () => {
    // Arrange
    bridge.start.mockClear()
    const onSessionStarted = vi.fn()
    const onSessionEnded = vi.fn()
    const props = {
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
})
