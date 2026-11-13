import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { type KeyValueStore, createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"

import { AiReviewPanel, createChatInitialPrompt, createInitialPrompt } from "./AiReviewPanel"

const TARGET = { owner: "acme", repo: "webapp", number: 42 }

async function createStoreWithCodexChosen(): Promise<KeyValueStore> {
  const store = createMemoryKeyValueStore()
  await createAiReviewSettingsStorage(store).saveTerminalProvider("codex")
  return store
}

async function createStoreWithProviderAndSurface(
  provider: "claude" | "codex",
  surface: "terminal" | "chat"
): Promise<KeyValueStore> {
  const store = createMemoryKeyValueStore()
  const settingsStorage = createAiReviewSettingsStorage(store)
  await settingsStorage.saveTerminalProvider(provider)
  await settingsStorage.savePanelSurface(surface)
  return store
}

// The settings row: its summary names the current choice, e.g. "Claude · Haiku · Chat".
function settingsSummary(): HTMLElement {
  return screen.getByText(/^(Choose a provider$|(Codex|Claude) · (?!Hide))/, {
    selector: "summary",
  })
}

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const summary = await waitFor(settingsSummary)
  if (!summary.parentElement?.hasAttribute("open")) await user.click(summary)
}

function renderPanel(storage: KeyValueStore = createMemoryKeyValueStore()) {
  return render(
    <AiReviewPanel
      target={TARGET}
      storage={storage}
      title="Terminal review"
      baseSha="base-sha"
      headSha="head-sha"
      currentFilePath="src/app.ts"
      review={null}
      onTerminalSessionStarted={() => {}}
      onTerminalSessionEnded={() => {}}
    />
  )
}

describe("AiReviewPanel terminal surface", () => {
  it("does_not_start_a_terminal_until_a_provider_is_chosen", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel()
    const choosePrompt = await screen.findByText("Choose a provider, then press Start.")
    // The aside is labelled "AI terminal" until the choice, so match only the terminal section.
    const terminalWasMountedBeforeChoice =
      screen.queryByLabelText(/^(Codex|Claude) terminal$/) !== null

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Codex")

    // Assert
    expect(choosePrompt).toHaveAttribute("role", "status")
    expect(terminalWasMountedBeforeChoice).toBe(false)
    expect(await screen.findByLabelText("Codex terminal")).toBeInTheDocument()
  })

  it("shows_the_model_control_and_not_the_old_review_tabs", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())

    // Act
    await openSettings(user)

    // Assert
    expect(screen.getByLabelText("Model")).toBeVisible()
    expect(await screen.findByLabelText("Codex terminal")).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Review PR" })).not.toBeInTheDocument()
  })

  it("keeps_the_terminal_mounted_when_collapsed", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())
    await screen.findByLabelText("Codex terminal")

    // Act
    await user.click(screen.getByRole("button", { name: "Codex · Hide" }))

    // Assert
    expect(screen.getByLabelText("Codex terminal")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show Codex" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("switching_provider_to_claude_relabels_the_terminal_and_lists_claude_models", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())
    await screen.findByLabelText("Codex terminal")
    await openSettings(user)

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Claude")

    // Assert
    const modelSelect = screen.getByLabelText("Model")
    expect(await screen.findByLabelText("Claude terminal")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Claude · Hide" })).toBeInTheDocument()
    expect(within(modelSelect).getByRole("option", { name: "Opus — balanced" })).toBeInTheDocument()
    expect(
      within(modelSelect).queryByRole("option", { name: "GPT-6 Astra — frontier" })
    ).not.toBeInTheDocument()
  })

  it("offers_haiku_among_the_claude_model_aliases", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())
    await screen.findByLabelText("Codex terminal")
    await openSettings(user)

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Claude")

    // Assert
    const modelSelect = screen.getByLabelText("Model")
    expect(
      within(modelSelect).getByRole("option", { name: "Haiku — fastest (default)" })
    ).toBeInTheDocument()
  })

  it("remembers_the_terminal_provider_for_the_next_mount", async () => {
    // Arrange
    const user = userEvent.setup()
    const storage = await createStoreWithCodexChosen()
    const firstMount = renderPanel(storage)
    await screen.findByLabelText("Codex terminal")
    await openSettings(user)
    await user.selectOptions(screen.getByLabelText("Provider"), "Claude")
    await screen.findByLabelText("Claude terminal")
    firstMount.unmount()

    // Act
    renderPanel(storage)

    // Assert
    expect(await screen.findByLabelText("Claude terminal")).toBeInTheDocument()
  })

  it("tells_the_agent_to_prefer_sem_diff_over_the_pr_range_when_sem_is_installed", () => {
    // Arrange
    const baseSha = "base-sha"
    const headSha = "head-sha"

    // Act
    const prompt = createInitialPrompt({
      target: TARGET,
      title: "Terminal review",
      baseSha,
      headSha,
      currentFilePath: null,
    })

    // Assert
    const expected = `If the sem CLI is installed (check with command -v sem), prefer sem diff -v --from ${baseSha} --to ${headSha}`
    expect(prompt).toContain(expected)
  })

  it("tells_the_agent_to_call_get_current_file_for_this_file_or_these_lines", () => {
    // Arrange
    const currentFilePath = "src/app.ts"

    // Act
    const prompt = createInitialPrompt({
      target: TARGET,
      title: "Terminal review",
      baseSha: "base-sha",
      headSha: "head-sha",
      currentFilePath,
    })

    // Assert
    const expected =
      'The get_current_file tool shows the file and lines the reviewer is looking at right now. Call it when the reviewer says "this file" or "these lines".'
    expect(prompt).toContain(expected)
  })

  it("adds_a_custom_shortcut_that_appears_in_the_terminal_header", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())
    const terminal = await screen.findByLabelText("Codex terminal")
    await openSettings(user)
    const shortcutLabel = "Summarize"
    const shortcutTemplate = "Summarize the changes up to {headSha}"
    await user.click(screen.getByText("Custom shortcuts"))
    await user.type(screen.getByLabelText("Shortcut label"), shortcutLabel)
    // user.type treats "{" as a key descriptor, so the template is pasted instead.
    await user.click(screen.getByLabelText("Prompt template"))
    await user.paste(shortcutTemplate)

    // Act
    await user.click(screen.getByRole("button", { name: "Add shortcut" }))
    const headerButton = await within(terminal).findByRole("button", { name: shortcutLabel })
    await user.click(screen.getByRole("button", { name: `Remove ${shortcutLabel}` }))

    // Assert
    expect(headerButton).not.toBeInTheDocument()
  })
  it("the_surface_defaults_to_the_terminal_for_claude", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())
    await screen.findByLabelText("Codex terminal")
    await openSettings(user)

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Claude")

    // Assert
    expect(await screen.findByLabelText("Claude terminal")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Terminal" })).toBeChecked()
  })

  it("offers_the_chat_surface_only_for_claude", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithCodexChosen())
    await screen.findByLabelText("Codex terminal")

    // Act
    await openSettings(user)

    // Assert
    expect(screen.queryByRole("radio", { name: "Chat" })).not.toBeInTheDocument()
  })

  it("a_saved_chat_surface_with_codex_shows_the_terminal_and_keeps_the_setting", async () => {
    // Arrange
    const storage = await createStoreWithProviderAndSurface("codex", "chat")

    // Act
    renderPanel(storage)

    // Assert
    expect(await screen.findByLabelText("Codex terminal")).toBeInTheDocument()
    expect(screen.queryByLabelText("Codex chat")).not.toBeInTheDocument()
    expect((await createAiReviewSettingsStorage(storage).load()).panelSurface).toBe("chat")
  })

  it("a_provider_change_from_claude_chat_to_codex_shows_the_codex_terminal", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel(await createStoreWithProviderAndSurface("claude", "chat"))
    await screen.findByLabelText("Claude chat")
    await openSettings(user)

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Codex")

    // Assert
    expect(await screen.findByLabelText("Codex terminal")).toBeInTheDocument()
    expect(screen.queryByLabelText("Claude chat")).not.toBeInTheDocument()
  })

  it("the_chat_prompt_keeps_the_pr_facts_and_the_safety_line", () => {
    // Arrange
    const baseSha = "base-sha"
    const headSha = "head-sha"
    const currentFilePath = "src/app.ts"

    // Act
    const prompt = createChatInitialPrompt({
      target: TARGET,
      title: "Chat review",
      baseSha,
      headSha,
      currentFilePath,
    })

    // Assert
    const expectedLines = [
      "PR: https://github.com/acme/webapp/pull/42",
      `Selected file: ${currentFilePath}`,
      "Do not change branches, checkout commits, edit files, or run destructive commands.",
      `Prefer sem diff -v --from ${baseSha} --to ${headSha}`,
      "The get_current_file tool shows the file and lines the reviewer is looking at right now.",
    ]
    for (const expectedLine of expectedLines) expect(prompt).toContain(expectedLine)
  })

  it("the_chat_prompt_asks_for_answers_in_the_chat_with_clickable_file_links", () => {
    // Arrange
    const input = {
      target: TARGET,
      title: "Chat review",
      baseSha: "base-sha",
      headSha: "head-sha",
      currentFilePath: null,
    }

    // Act
    const prompt = createChatInitialPrompt(input)

    // Assert
    expect(prompt).toContain("Answer in this chat")
    expect(prompt).toContain("[src/app.ts:42](src/app.ts#L42)")
    // The terminal's mandatory render_answer rule must not reach the chat.
    expect(prompt).not.toContain("you must call render_answer")
  })

  it("the_chat_prompt_says_mermaid_is_not_rendered_and_to_draw_diagrams_with_an_openui_lang_block", () => {
    // Arrange
    const input = {
      target: TARGET,
      title: "Chat review",
      baseSha: "base-sha",
      headSha: "head-sha",
      currentFilePath: null,
    }

    // Act
    const prompt = createChatInitialPrompt(input)

    // Assert
    const expected =
      "Mermaid diagrams are not rendered in this chat, so draw a diagram with an openui-lang Diagram or SequenceDiagram block."
    expect(prompt).toContain(expected)
  })

  it.each([
    [
      "the_chat_prompt_says_render_answer_is_optional_shown_inline_and_not_to_be_repeated",
      "render_answer is optional in this chat. A rendered answer is shown inline in the chat, so do not repeat its content in your reply. openui-lang blocks, diagrams included, are drawn only in your chat reply and show as plain code inside a rendered answer, so put anything with a block in the reply.",
    ],
    [
      "the_chat_prompt_says_only_files_of_this_pr_are_clickable",
      "Only files of this PR are clickable in this chat. Write any other path as plain text.",
    ],
    [
      "the_chat_prompt_runs_the_git_diff_fallback_as_a_separate_command_not_with_or",
      "Only if that command fails, run git diff as a separate second command, never joined to it with ||.",
    ],
    [
      "the_chat_prompt_names_the_denied_commands_and_says_a_denial_is_for_that_command_only",
      "Some shell commands are denied in this chat without asking: subshells in parentheses, git rev-parse, and git diff with -U<n>. A denial applies to that one command only, so run a simpler read-only command such as git diff, git diff --stat, git show or git grep, and carry on.",
    ],
    [
      "the_chat_prompt_says_single_line_breaks_are_not_shown",
      "Single line breaks are not shown in this chat. Use a Markdown list, or a blank line between paragraphs.",
    ],
  ])("%s", (_promise, expectedLine) => {
    // Arrange
    const input = {
      target: TARGET,
      title: "Chat review",
      baseSha: "base-sha",
      headSha: "head-sha",
      currentFilePath: null,
    }

    // Act
    const prompt = createChatInitialPrompt(input)

    // Assert
    expect(prompt).toContain(expectedLine)
  })
})

describe("AiReviewPanel settings row", () => {
  it("the_settings_are_open_until_a_provider_is_chosen", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel()
    const summaryBeforeChoice = await waitFor(settingsSummary)
    const textBeforeChoice = summaryBeforeChoice.textContent
    const wasOpenBeforeChoice = summaryBeforeChoice.parentElement?.hasAttribute("open")

    // Act
    await user.selectOptions(screen.getByLabelText("Provider"), "Claude")

    // Assert
    expect(textBeforeChoice).toBe("Choose a provider")
    expect(wasOpenBeforeChoice).toBe(true)
    // Picking a provider in the open row does not close it under the reviewer's pointer.
    expect(screen.getByLabelText("Model")).toBeVisible()
  })

  it("once_a_provider_is_saved_the_settings_start_as_one_closed_row_naming_provider_model_and_surface", async () => {
    // Arrange
    const storage = await createStoreWithProviderAndSurface("claude", "chat")

    // Act
    renderPanel(storage)

    // Assert
    await screen.findByLabelText("Claude chat")
    const summary = settingsSummary()
    expect(summary).toHaveTextContent("Claude · Haiku · Chat")
    expect(summary.parentElement).not.toHaveAttribute("open")
    expect(screen.getByLabelText("Model")).not.toBeVisible()
  })

  it("opening_the_row_shows_the_controls_and_a_model_change_still_saves", async () => {
    // Arrange
    const user = userEvent.setup()
    const storage = await createStoreWithProviderAndSurface("claude", "terminal")
    renderPanel(storage)
    await screen.findByLabelText("Claude terminal")

    // Act
    await user.click(settingsSummary())
    await user.selectOptions(screen.getByLabelText("Model"), "Opus — balanced")

    // Assert
    await waitFor(async () =>
      expect(
        (await createAiReviewSettingsStorage(storage).load()).providers.claude.selectedModel
      ).toBe("opus")
    )
    expect(settingsSummary()).toHaveTextContent("Claude · Opus · Terminal")
  })

  it("the_codex_row_shows_no_surface_part", async () => {
    // Arrange
    const storage = await createStoreWithCodexChosen()

    // Act
    renderPanel(storage)

    // Assert
    await screen.findByLabelText("Codex terminal")
    expect(settingsSummary()).toHaveTextContent(/^Codex · GPT-5\.6 Luna$/)
  })

  it("a_failed_save_stays_visible_next_to_the_row_after_it_is_closed", async () => {
    // Arrange
    const user = userEvent.setup()
    const savedStore = await createStoreWithProviderAndSurface("claude", "terminal")
    const failingStore: KeyValueStore = {
      ...savedStore,
      set: () => Promise.reject(new Error("disk full")),
    }
    renderPanel(failingStore)
    await screen.findByLabelText("Claude terminal")
    await user.click(settingsSummary())
    await user.selectOptions(screen.getByLabelText("Model"), "Opus — balanced")

    // Act
    await user.click(settingsSummary())

    // Assert
    const error = await screen.findByText("Couldn't save the terminal settings: disk full")
    expect(settingsSummary().parentElement).not.toHaveAttribute("open")
    expect(error).toHaveAttribute("role", "alert")
    expect(error).toBeVisible()
  })

  // A CSS fact, not layout: jsdom does no layout, so this only guards the declaration.
  // That the row stays 28px and clickable at a 220px panel was measured in Chrome.
  it("the_settings_row_is_declared_to_never_shrink", async () => {
    // Arrange
    renderPanel(await createStoreWithCodexChosen())
    await screen.findByLabelText("Codex terminal")

    // Act
    const settingsRow = settingsSummary().parentElement!

    // Assert
    expect(getComputedStyle(settingsRow).flexShrink).toBe("0")
  })
})
