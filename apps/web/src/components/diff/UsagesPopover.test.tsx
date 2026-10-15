import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { SymbolAnchor } from "@/entity/anchor"

import { UsagesPopover } from "./UsagesPopover"

function anchorWithUsages(usages: SymbolAnchor["usages"]): SymbolAnchor {
  return {
    symbolId: "src/limits.ts#RateLimitConfig",
    name: "RateLimitConfig",
    role: "definition",
    hasCounterpart: true,
    line: 1,
    definition: null,
    usages,
  }
}

describe("UsagesPopover", () => {
  it("splits usages into in-PR and not-in-PR groups when a ghost usage exists", () => {
    // Arrange
    const changedPaths = new Set(["src/changed.ts"])
    const anchor = anchorWithUsages([
      { path: "src/changed.ts", line: 4 },
      { path: "src/ghost.ts", line: 9 },
    ])

    // Act
    render(
      <UsagesPopover
        anchor={anchor}
        changedPaths={changedPaths}
        peekedUsage={null}
        peekContent={null}
        onPeek={vi.fn()}
        onJumpTo={vi.fn()}
      />
    )

    // Assert — both group labels render, each usage under its own group.
    expect(screen.getByText("In this PR")).toBeInTheDocument()
    expect(screen.getByText(/Not in this PR/)).toBeInTheDocument()
    expect(screen.getByText("src/changed.ts:4")).toBeInTheDocument()
    expect(screen.getByText("src/ghost.ts:9")).toBeInTheDocument()
  })

  it("stays a flat list when every usage is inside the PR", () => {
    // Arrange
    const changedPaths = new Set(["src/changed.ts"])
    const anchor = anchorWithUsages([
      { path: "src/changed.ts", line: 4 },
      { path: "src/changed.ts", line: 11 },
    ])

    // Act
    render(
      <UsagesPopover
        anchor={anchor}
        changedPaths={changedPaths}
        peekedUsage={null}
        peekContent={null}
        onPeek={vi.fn()}
        onJumpTo={vi.fn()}
      />
    )

    // Assert — no group labels on the common case.
    expect(screen.queryByText("In this PR")).toBeNull()
    expect(screen.queryByText(/Not in this PR/)).toBeNull()
    expect(screen.getByText("src/changed.ts:11")).toBeInTheDocument()
  })

  it("peeks_a_usage_on_click_and_jumps_on_meta_click", async () => {
    // Arrange
    const user = userEvent.setup()
    const changedPaths = new Set(["src/changed.ts"])
    const peekedUsage = { path: "src/changed.ts", line: 4 }
    const jumpedUsage = { path: "src/changed.ts", line: 11 }
    const anchor = anchorWithUsages([peekedUsage, jumpedUsage])
    const onPeek = vi.fn()
    const onJumpTo = vi.fn()
    render(
      <UsagesPopover
        anchor={anchor}
        changedPaths={changedPaths}
        peekedUsage={null}
        peekContent={null}
        onPeek={onPeek}
        onJumpTo={onJumpTo}
      />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "src/changed.ts:4" }))
    await user.keyboard("{Meta>}")
    await user.click(screen.getByRole("button", { name: "src/changed.ts:11" }))
    await user.keyboard("{/Meta}")

    // Assert
    const expected = { peeked: [[peekedUsage]], jumped: [[jumpedUsage]] }
    expect({ peeked: onPeek.mock.calls, jumped: onJumpTo.mock.calls }).toEqual(expected)
  })

  it("renders_the_peek_content_under_the_peeked_usage", () => {
    // Arrange
    const changedPaths = new Set(["src/changed.ts"])
    const peekedUsage = { path: "src/ghost.ts", line: 9 }
    const anchor = anchorWithUsages([{ path: "src/changed.ts", line: 4 }, peekedUsage])
    const peekText = "peeked code"

    // Act
    render(
      <UsagesPopover
        anchor={anchor}
        changedPaths={changedPaths}
        peekedUsage={peekedUsage}
        peekContent={<p>{peekText}</p>}
        onPeek={vi.fn()}
        onJumpTo={vi.fn()}
      />
    )

    // Assert
    const peekedButton = screen.getByRole("button", { name: "src/ghost.ts:9" })
    expect(peekedButton).toHaveAttribute("aria-expanded", "true")
    expect(peekedButton.nextElementSibling).toHaveTextContent(peekText)
    expect(screen.getByRole("button", { name: "src/changed.ts:4" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })
})
