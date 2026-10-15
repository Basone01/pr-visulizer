import { describe, expect, it } from "vitest"

import {
  TERMINAL_PROMPT_SHORTCUTS,
  type TerminalPromptShortcutContext,
  toPromptShortcut,
} from "./terminalPromptShortcuts"

describe("terminal prompt shortcuts", () => {
  it("pr_description_shortcut_builds_the_sem_pr_prompt_without_test_sections", () => {
    // Arrange
    const shortcutId = "pr-description"
    const baseSha = "base-sha-42"
    const headSha = "head-sha-42"
    const context: TerminalPromptShortcutContext = {
      prUrl: "https://github.com/acme/web/pull/42",
      title: "MDT-1234 add terminal shortcuts",
      baseSha,
      headSha,
      selectedFile: null,
    }
    const shortcut = TERMINAL_PROMPT_SHORTCUTS.find((entry) => entry.id === shortcutId)

    // Act
    const prompt = shortcut?.buildPrompt(context) ?? ""

    // Assert
    expect(prompt).toContain(`sem diff -v --from ${baseSha} --to ${headSha}`)
    expect(prompt).toContain("## System design")
    expect(prompt).toContain("## Changes")
    expect(prompt).toContain("## JIRA")
    expect(prompt).toContain("render_answer")
    expect(prompt).not.toContain("Test scenario")
    expect(prompt).not.toContain("Test Report")
  })

  it("custom_template_substitutes_known_placeholders_and_keeps_other_braces", () => {
    // Arrange
    const baseSha = "base-sha-42"
    const template = "Compare {baseSha} for {TICKET-ID}"
    const context: TerminalPromptShortcutContext = {
      prUrl: "https://github.com/acme/web/pull/42",
      title: "Add shortcuts",
      baseSha,
      headSha: "head-sha-42",
      selectedFile: "src/app.ts",
    }
    const shortcut = toPromptShortcut({ id: "compare", label: "Compare", template })

    // Act
    const prompt = shortcut.buildPrompt(context)

    // Assert
    const expected = `Compare ${baseSha} for {TICKET-ID}`
    expect(prompt).toBe(expected)
  })

  it("custom_shortcut_substitutes_the_missing_file_wording_when_no_file_is_selected", () => {
    // Arrange
    const template = "Explain {selectedFile}"
    const context: TerminalPromptShortcutContext = {
      prUrl: "https://github.com/acme/web/pull/42",
      title: "Add shortcuts",
      baseSha: "base-sha-42",
      headSha: "head-sha-42",
      selectedFile: null,
    }
    const shortcut = toPromptShortcut({ id: "explain", label: "Explain", template })

    // Act
    const prompt = shortcut.buildPrompt(context)

    // Assert
    const expected = "Explain No file is selected."
    expect(prompt).toBe(expected)
  })
})
