import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { AiReviewPanel } from "./AiReviewPanel"

const TARGET = { owner: "acme", repo: "webapp", number: 42 }

function renderPanel() {
  return render(
    <AiReviewPanel
      target={TARGET}
      storage={createMemoryKeyValueStore()}
      title="Terminal review"
      baseSha="base-sha"
      headSha="head-sha"
      currentFilePath="src/app.ts"
      onTerminalSessionStarted={() => {}}
      onTerminalSessionEnded={() => {}}
    />
  )
}

describe("AiReviewPanel terminal surface", () => {
  it("shows_the_model_control_and_not_the_old_review_tabs", async () => {
    // Arrange
    renderPanel()

    // Act
    const model = screen.getByLabelText("Model")

    // Assert
    expect(model).toBeInTheDocument()
    expect(await screen.findByLabelText("Codex terminal")).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Review PR" })).not.toBeInTheDocument()
  })

  it("keeps_the_terminal_mounted_when_collapsed", async () => {
    // Arrange
    const user = userEvent.setup()
    renderPanel()
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
})
