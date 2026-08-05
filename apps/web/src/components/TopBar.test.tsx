import type { PrMeta } from "@pr-visulizer/shared"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { TopBar } from "./TopBar"

// Deep-only desktop (docs/tauri-architecture.md §6): the deepen button is GONE — the top bar
// carries the engine badge (always DEEP · REPO in tauri mode, driven by the engine prop) and,
// desktop only, the clone-folder gear. These tests supersede the old TopBar.deepen tests.

const pr: PrMeta = {
  owner: "acme",
  repo: "web",
  number: 42,
  title: "Add login rate limiting",
  author: "octocat",
  baseSha: "a1b2c3d",
  headSha: "3f9c2e1abcdef",
}

function renderTopBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const props = {
    pr,
    engine: "deep" as const,
    onBack: () => {},
    showSettings: true,
    onOpenCloneSettings: () => {},
    onRefresh: () => {},
    refreshing: false,
    ...overrides,
  }

  render(<TopBar {...props} />)
}

describe("TopBar (deep-only)", () => {
  it("shows the DEEP · REPO badge and the settings gear in the desktop shell", () => {
    // Arrange
    const showSettings = true

    // Act
    renderTopBar({ showSettings })

    // Assert
    expect(screen.getByText("DEEP · REPO")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clone folder settings" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Deepen analysis/ })).toBeNull()
  })

  it("hides the gear outside the desktop shell and badges the fast engine", () => {
    // Arrange
    const showSettings = false
    const engine = "fast" as const

    // Act
    renderTopBar({ showSettings, engine })

    // Assert
    expect(screen.getByText("FAST · AST")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clone folder settings" })).toBeNull()
  })
})

// The refresh button re-reads the open PR at its current head. It is in the top bar in every
// mode (not gated on the desktop like the gear), because a browser reviewer needs the new
// commits just as much as a desktop one.
describe("TopBar — refresh", () => {
  it("asks for a refresh when clicked", async () => {
    // Arrange
    const onRefresh = vi.fn()
    renderTopBar({ onRefresh })

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Refresh PR" }))

    // Assert
    const expectedCalls = 1
    expect(onRefresh.mock.calls.length).toBe(expectedCalls)
  })

  it("disables the button while the refresh is in flight", async () => {
    // Arrange
    const onRefresh = vi.fn()
    const refreshing = true
    renderTopBar({ onRefresh, refreshing })

    // Act
    const button = screen.getByRole("button", { name: "Refresh PR" })
    await userEvent.click(button)

    // Assert — a second click can't stack another refresh onto the running one.
    const expectedCalls = 0
    expect(button).toBeDisabled()
    expect(onRefresh.mock.calls.length).toBe(expectedCalls)
  })
})
