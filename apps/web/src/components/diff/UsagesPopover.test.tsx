import { render, screen } from "@testing-library/react"
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
    render(<UsagesPopover anchor={anchor} changedPaths={changedPaths} onJumpTo={vi.fn()} />)

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
    render(<UsagesPopover anchor={anchor} changedPaths={changedPaths} onJumpTo={vi.fn()} />)

    // Assert — no group labels on the common case.
    expect(screen.queryByText("In this PR")).toBeNull()
    expect(screen.queryByText(/Not in this PR/)).toBeNull()
    expect(screen.getByText("src/changed.ts:11")).toBeInTheDocument()
  })
})
