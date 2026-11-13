import { act, render, screen } from "@testing-library/react"
import { Component, type ReactNode, useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ContainedRoot } from "./ContainedRoot"

// Stand-ins for OpenUI's per-element boundary, so these tests drive ContainedRoot directly.

// Catches a render error once per update and shows a recovered state, then retries the
// children when the next update arrives (as OpenUI does when new children stream in).
type RecoveringBoundaryProps = { version: number; children: ReactNode }

class RecoveringBoundary extends Component<RecoveringBoundaryProps, { hasError: boolean }> {
  override state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  override componentDidUpdate(previous: RecoveringBoundaryProps): void {
    if (this.state.hasError && previous.version !== this.props.version) {
      this.setState({ hasError: false })
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) return <p>recovered at update {this.props.version}</p>

    return this.props.children
  }
}

function ThrowsInRender(): never {
  throw new Error("one broken element")
}

// Re-renders the same children after an error, like OpenUI's "last good children".
// With a child that throws from an effect, that is the runaway loop.
class LastGoodChildrenBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  override componentDidUpdate(): void {
    if (this.state.hasError) this.setState({ hasError: false })
  }

  override render(): ReactNode {
    return this.props.children
  }
}

function ThrowsInEffect(): ReactNode {
  useEffect(() => {
    throw new Error("effect failure")
  })
  return <p>looping</p>
}

const FALLBACK_TEXT = "block fallback"

afterEach(() => {
  // ContainedRoot unmounts its inner root on a timer, so let that run before restoring timers.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("ContainedRoot counts a runaway loop, not a block that recovers on each update", () => {
  it("a block that recovers from one error per update stays visible across many updates, even under fake timers", async () => {
    // Arrange
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const updateCount = 12
    const block = (version: number) => (
      <ContainedRoot fallback={<p>{FALLBACK_TEXT}</p>}>
        <RecoveringBoundary version={version}>
          <ThrowsInRender />
        </RecoveringBoundary>
      </ContainedRoot>
    )
    const { rerender } = render(block(0))

    // Act
    for (let version = 1; version <= updateCount; version += 1) {
      await act(async () => {
        rerender(block(version))
      })
    }

    // Assert
    const expectedText = `recovered at update ${updateCount}`
    expect(screen.getByText(expectedText)).toBeInTheDocument()
  })
})

describe("ContainedRoot keeps a tripped block on its fallback", () => {
  it("a block that tripped the runaway limit stays on the fallback when later children would render", async () => {
    // Arrange
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { rerender } = render(
      <ContainedRoot fallback={<p>{FALLBACK_TEXT}</p>}>
        <LastGoodChildrenBoundary>
          <ThrowsInEffect />
        </LastGoodChildrenBoundary>
      </ContainedRoot>
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Act
    await act(async () => {
      rerender(
        <ContainedRoot fallback={<p>{FALLBACK_TEXT}</p>}>
          <p>healthy content</p>
        </ContainedRoot>
      )
    })

    // Assert
    expect([
      screen.queryByText(FALLBACK_TEXT) !== null,
      screen.queryByText("healthy content"),
    ]).toEqual([true, null])
  })
})
