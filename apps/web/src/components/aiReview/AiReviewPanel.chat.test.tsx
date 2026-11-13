import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { type KeyValueStore, createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { REPO_LINKS_KEY } from "@/entity/repoSource"

import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"

import { AiReviewPanel } from "./AiReviewPanel"

// The desktop runtime and a linked repository, so the chat can really reach Start and run.
// Without them the chat stops at "available in the desktop app" and no promise here is tested.
const tauri = vi.hoisted(() => {
  ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  return { invoke: vi.fn(), Channel: class {} }
})

// xterm needs a real canvas, so the terminal surface gets the same stand-in CodexTerminal.test uses.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24
    cols = 80
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    paste() {}
    onData() {
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

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: tauri.Channel }))
vi.mock("@/components/openui/reviewUiPrompt", () => ({
  buildReviewUiPrompt: () => "Use the review component library.",
}))

const TARGET = { owner: "acme", repo: "webapp", number: 42 }

function settingsSummary(): HTMLElement {
  return screen.getByText(/^(Claude|Codex) · /, { selector: "summary" })
}

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const summary = settingsSummary()
  if (!summary.parentElement?.hasAttribute("open")) await user.click(summary)
}

// The provider decides the surface: Claude opens the chat, Codex the terminal.
async function createLinkedStore(provider: "claude" | "codex"): Promise<KeyValueStore> {
  const store = createMemoryKeyValueStore()
  const repoLink = { path: "/repo", owner: TARGET.owner, repo: TARGET.repo }
  await store.set(REPO_LINKS_KEY, JSON.stringify([repoLink]))
  await createAiReviewSettingsStorage(store).saveTerminalProvider(provider)
  return store
}

function renderPanel(storage: KeyValueStore) {
  return render(
    <AiReviewPanel
      target={TARGET}
      storage={storage}
      title="Chat review"
      baseSha="base-sha"
      headSha="head-sha"
      currentFilePath="src/app.ts"
      changedFiles={[]}
      analysisReady
      review={null}
      onTerminalSessionStarted={() => {}}
      onTerminalSessionEnded={() => {}}
    />
  )
}

function requestsOf(command: string): Array<Record<string, unknown>> {
  return tauri.invoke.mock.calls
    .filter(([invokedCommand]) => invokedCommand === command)
    .map(([, args]) => (args as { request: Record<string, unknown> }).request)
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.invoke.mockResolvedValue(undefined)
})

describe("AiReviewPanel surfaces in the desktop app", () => {
  it("a_provider_change_from_claude_to_codex_ends_the_running_chat_and_relaunches_nothing", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createLinkedStore("claude"))
    await user.click(await screen.findByRole("button", { name: "Start" }))
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(1))
    const chatSessionId = requestsOf("ai_chat_start")[0]?.sessionId
    await openSettings(user)

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Codex")

    // Assert
    const terminal = await screen.findByLabelText("Codex terminal")
    expect(within(terminal).getByRole("button", { name: "Start" })).toBeInTheDocument()
    await waitFor(() => expect(requestsOf("ai_chat_stop")).toEqual([{ sessionId: chatSessionId }]))
    expect(requestsOf("codex_terminal_start")).toEqual([])
  })

  it("a_provider_change_from_codex_to_claude_ends_the_running_terminal_and_relaunches_nothing", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createLinkedStore("codex"))
    await user.click(await screen.findByRole("button", { name: "Start" }))
    await screen.findByRole("button", { name: "Stop" })
    const terminalSessionId = requestsOf("codex_terminal_start")[0]?.sessionId
    await openSettings(user)

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Claude")

    // Assert
    const chat = await screen.findByLabelText("Claude chat")
    expect(within(chat).getByRole("button", { name: "Start" })).toBeInTheDocument()
    await waitFor(() =>
      expect(requestsOf("codex_terminal_stop")).toEqual([{ sessionId: terminalSessionId }])
    )
    expect(requestsOf("ai_chat_start")).toEqual([])
  })

  it("toggling_the_settings_row_does_not_restart_or_stop_a_running_chat", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createLinkedStore("claude"))
    await user.click(await screen.findByRole("button", { name: "Start" }))
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(1))

    // Act
    await user.click(settingsSummary())
    await user.click(settingsSummary())

    // Assert
    expect(requestsOf("ai_chat_start")).toHaveLength(1)
    expect(requestsOf("ai_chat_stop")).toEqual([])
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
  })

  it("toggling_the_settings_row_does_not_restart_or_stop_a_running_terminal", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createLinkedStore("codex"))
    await user.click(await screen.findByRole("button", { name: "Start" }))
    await screen.findByRole("button", { name: "Stop" })

    // Act
    await user.click(settingsSummary())
    await user.click(settingsSummary())

    // Assert
    expect(requestsOf("codex_terminal_start")).toHaveLength(1)
    expect(requestsOf("codex_terminal_stop")).toEqual([])
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
  })

  it("the_chat_shows_a_diagram_changes_shortcut", async () => {
    // Arrange
    const storage = await createLinkedStore("claude")

    // Act
    renderPanel(storage)

    // Assert
    const chat = await screen.findByLabelText("Claude chat")
    const shortcuts = within(chat).getByRole("group", { name: "Prompt shortcuts" })
    expect(within(shortcuts).getByRole("button", { name: "Diagram changes" })).toBeInTheDocument()
  })

  it("the_codex_terminal_does_not_show_the_diagram_changes_shortcut", async () => {
    // Arrange
    const storage = await createLinkedStore("codex")

    // Act
    renderPanel(storage)

    // Assert
    const terminal = await screen.findByLabelText("Codex terminal")
    const shortcuts = within(terminal).getByRole("group", { name: "Prompt shortcuts" })
    expect(within(shortcuts).getByRole("button", { name: "PR description" })).toBeInTheDocument()
    expect(
      within(shortcuts).queryByRole("button", { name: "Diagram changes" })
    ).not.toBeInTheDocument()
  })

  it("the_diagram_changes_shortcut_fills_the_composer_with_the_diagram_prompt_without_sending", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createLinkedStore("claude"))
    await user.click(await screen.findByRole("button", { name: "Start" }))
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(1))
    const shortcut = await screen.findByRole("button", { name: "Diagram changes" })
    await waitFor(() => expect(shortcut).toBeEnabled())

    // Act
    await user.click(shortcut)

    // Assert
    const composer = screen.getByRole("textbox", { name: "Message Claude" })
    const composerText = (composer as HTMLTextAreaElement).value
    expect(composerText).toContain(
      "Summarize what this PR changes in the system as one diagram first"
    )
    expect(composerText).toContain("at most five short bullets")
    expect(composerText).toContain(
      "Draw the diagram in your chat reply, not through render_answer."
    )
    expect(composerText).toContain(
      `PR: https://github.com/${TARGET.owner}/${TARGET.repo}/pull/${TARGET.number}`
    )
    expect(requestsOf("ai_chat_send")).toHaveLength(1)
  })

  it("two_quick_model_picks_send_one_switch_each_in_pick_order", async () => {
    // Arrange
    const user = userEvent.setup()
    const store = await createLinkedStore("claude")
    // Holds every save until the test lets it land, standing in for a slow settings file.
    const heldSaves: Array<() => void> = []
    let holdSaves = false
    const slowStore: KeyValueStore = {
      ...store,
      get: (key) => store.get(key),
      delete: (key) => store.delete(key),
      set: async (key, value) => {
        if (holdSaves) await new Promise<void>((resolve) => heldSaves.push(resolve))
        await store.set(key, value)
      },
    }
    renderPanel(slowStore)
    await user.click(await screen.findByRole("button", { name: "Start" }))
    await waitFor(() => expect(requestsOf("ai_chat_send")).toHaveLength(1))
    await openSettings(user)
    holdSaves = true
    await user.selectOptions(screen.getByLabelText("Model"), "opus")
    await user.selectOptions(screen.getByLabelText("Model"), "sonnet")

    // Act
    while (heldSaves.length > 0) {
      await act(async () => heldSaves.shift()?.())
    }

    // Assert
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("sonnet"))
    const switchedModels = requestsOf("ai_chat_set_model").map((request) => request.model)
    expect(switchedModels).toEqual(["opus", "sonnet"])
  })
})
