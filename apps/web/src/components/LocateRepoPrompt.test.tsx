import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LocateRepoPrompt } from "./LocateRepoPrompt"

// The locate-vs-clone prompt (docs/tauri-architecture.md §6): first open with no linked repo
// and no clone root offers "Locate local clone…" (preferred) and "Clone it for me" (fallback),
// with inline errors when the picked folder doesn't validate.

function renderPrompt(overrides: Partial<Parameters<typeof LocateRepoPrompt>[0]> = {}) {
  const props = {
    slug: "acme/web",
    error: null,
    busy: false,
    onLocate: () => {},
    onClone: () => {},
    ...overrides,
  }

  render(<LocateRepoPrompt {...props} />)
}

describe("LocateRepoPrompt", () => {
  it("offers locate (preferred) and clone (fallback) for the PR's repo", () => {
    // Arrange
    const slug = "acme/web"

    // Act
    renderPrompt({ slug })

    // Assert
    expect(screen.getByText(slug)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Locate local clone…" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Clone it for me" })).toBeEnabled()
  })

  it("wires each button to its handler", () => {
    // Arrange
    const onLocate = vi.fn()
    const onClone = vi.fn()
    renderPrompt({ onLocate, onClone })

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Locate local clone…" }))
    fireEvent.click(screen.getByRole("button", { name: "Clone it for me" }))

    // Assert
    expect(onLocate).toHaveBeenCalledTimes(1)
    expect(onClone).toHaveBeenCalledTimes(1)
  })

  it("shows the inline validation error", () => {
    // Arrange
    const validationError = "That clone is acme/mobile, not acme/web"

    // Act
    renderPrompt({ error: validationError })

    // Assert
    expect(screen.getByRole("alert")).toHaveTextContent(validationError)
  })
})
