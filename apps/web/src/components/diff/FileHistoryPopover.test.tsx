import type { PrCommit } from "@pr-visulizer/shared"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FileHistoryPopover } from "./FileHistoryPopover"

function commit(sha: string, messageHeadline: string): PrCommit {
  return { sha, parents: [], messageHeadline, author: "mona", authoredAt: "2026-07-01T10:00:00Z" }
}

describe("FileHistoryPopover", () => {
  it("highlights_the_active_change_and_reports_the_count", () => {
    // Arrange
    const newest = commit("c0ffee3000000000000000000000000000000003", "Add the rate limiter")
    const oldest = commit("c0ffee1000000000000000000000000000000001", "Add rate-limit config")
    const entries = [newest, oldest]
    const activeSha = oldest.sha

    // Act
    render(
      <FileHistoryPopover
        entries={entries}
        activeSha={activeSha}
        truncated={false}
        isLoading={false}
        error={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    )

    // Assert
    const pressedHeadlines = screen
      .getAllByRole("button", { pressed: true })
      .map((button) => button.textContent)
    const expected = {
      count: "2 changes to this file",
      pressed: [expect.stringContaining(oldest.messageHeadline)],
    }
    expect({
      count: screen.getByText(/changes to this file/).textContent,
      pressed: pressedHeadlines,
    }).toEqual(expected)
  })
})
