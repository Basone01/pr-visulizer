import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { type KeyValueStore, createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"

import { AiReviewPanel, createInitialPrompt } from "./AiReviewPanel"

const TARGET = { owner: "acme", repo: "webapp", number: 42 }

async function createStoreWithCodexChosen(): Promise<KeyValueStore> {
  const store = createMemoryKeyValueStore()
  await createAiReviewSettingsStorage(store).saveTerminalProvider("codex")
  return store
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
    renderPanel(await createStoreWithCodexChosen())

    // Act
    const model = await screen.findByLabelText("Model")

    // Assert
    expect(model).toBeInTheDocument()
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
})
