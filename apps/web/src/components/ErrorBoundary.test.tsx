import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ErrorBoundary } from "./ErrorBoundary"

// A child that throws during render — the exact shape of a diff-render crash.
function Bomb(): never {
  throw new Error("diff blew up")
}

describe("ErrorBoundary", () => {
  // React logs caught render errors to console.error; silence it so the test output is clean.
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it("renders children normally when they don't throw", () => {
    // Arrange
    const childText = "the diff"

    // Act
    render(<ErrorBoundary fallback={() => <div>fallback</div>}>{childText}</ErrorBoundary>)

    // Assert
    expect(screen.getByText(childText)).toBeInTheDocument()
  })

  it("shows the fallback (with the error message) instead of crashing when a child throws", () => {
    // Arrange
    const expectedMessage = "diff blew up"

    // Act
    render(
      <ErrorBoundary fallback={(error) => <div>caught: {error.message}</div>}>
        <Bomb />
      </ErrorBoundary>
    )

    // Assert
    expect(screen.getByText(`caught: ${expectedMessage}`)).toBeInTheDocument()
  })
})
