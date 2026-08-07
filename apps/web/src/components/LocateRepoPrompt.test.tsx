import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LocateRepoPrompt } from "./LocateRepoPrompt"

// The locate-vs-clone chooser (docs/tauri-architecture.md §6): opening a PR whose repo has no
// linked clone and no clone root offers "Locate local clone…" (preferred), "Clone it for me…"
// (fallback) and a way out, with inline errors when the picked folder doesn't validate — and,
// once a clone is running, the phase in place of the choices.

function renderPrompt(overrides: Partial<Parameters<typeof LocateRepoPrompt>[0]> = {}) {
  const props = {
    slug: "acme/web",
    error: null,
    busy: false,
    preparing: null,
    onLocate: () => {},
    onClone: () => {},
    onCancel: () => {},
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
    expect(screen.getByRole("button", { name: "Clone it for me…" })).toBeEnabled()
  })

  it("wires each button to its handler", () => {
    // Arrange
    const onLocate = vi.fn()
    const onClone = vi.fn()
    renderPrompt({ onLocate, onClone })

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Locate local clone…" }))
    fireEvent.click(screen.getByRole("button", { name: "Clone it for me…" }))

    // Assert
    expect(onLocate).toHaveBeenCalledTimes(1)
    expect(onClone).toHaveBeenCalledTimes(1)
  })

  it("offers a way out that leaves the PR", () => {
    // Arrange
    const onCancel = vi.fn()
    renderPrompt({ onCancel })

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    // Assert
    const expectedCalls = 1
    expect(onCancel).toHaveBeenCalledTimes(expectedCalls)
  })

  it("shows the clone phase in place of the choices while a clone runs", () => {
    // Arrange — git's own progress line, relayed from the clone manager.
    const preparing = "cloning — Receiving objects: 42%"

    // Act
    renderPrompt({ preparing })

    // Assert — the wait is explained HERE, and the two choices are gone until it finishes.
    expect(screen.getByRole("status")).toHaveTextContent(preparing)
    expect(screen.queryByRole("button", { name: "Locate local clone…" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Clone it for me…" })).toBeNull()
    expect(screen.getByRole("button", { name: "Back to home" })).toBeEnabled()
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
