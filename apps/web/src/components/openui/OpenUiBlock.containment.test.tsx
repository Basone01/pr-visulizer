import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import OpenUiBlock from "./OpenUiBlock"

// No jsdom polyfills here on purpose: this file sets up a component that throws from an effect.
// OpenUI's charts build a ResizeObserver in an effect, so a ResizeObserver that throws makes
// OpenUI's element boundary re-render the same failing children until React gives up with
// "Maximum update depth exceeded", the failure no error boundary can catch.
class ThrowingResizeObserver {
  constructor() {
    throw new Error("ResizeObserver is broken on this platform")
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("OpenUiBlock containment", () => {
  it("a block whose component throws from an effect shows its fallback and the chat around it keeps rendering", async () => {
    // Arrange
    vi.stubGlobal("ResizeObserver", ThrowingResizeObserver)
    // Only the ResizeObserver may fail: PieChart also reads matchMedia, which jsdom lacks.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const chartCode = 'root = Stack([chart])\nchart = PieChart(["auth", "db"], [3, 1])'
    const chatMessage = "Earlier chat message"

    // Act
    render(
      <div>
        <p>{chatMessage}</p>
        <OpenUiBlock
          code={chartCode}
          streaming={false}
          canOpenFile={() => true}
          onOpenFile={() => {}}
          onFollowUp={() => {}}
        />
      </div>
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Assert
    const fallback = screen.getByRole("figure", { name: /could not be shown/i })
    expect([screen.getByText(chatMessage).isConnected, fallback.textContent]).toEqual([
      true,
      expect.stringContaining('PieChart(["auth", "db"]'),
    ])
  })
})
