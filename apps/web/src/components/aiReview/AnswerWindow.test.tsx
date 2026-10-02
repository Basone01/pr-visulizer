import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { AnswerWindow } from "./AnswerWindow"

const bridge = vi.hoisted(() => ({ load: vi.fn(), openFile: vi.fn(), subscribe: vi.fn() }))

vi.mock("@/service/terminal/answerWindow", () => ({
  loadAnswerReport: bridge.load,
  openAnswerFile: bridge.openFile,
  subscribeAnswerReports: bridge.subscribe,
}))

const REPORT = {
  version: 1 as const,
  sessionId: "session-1",
  title: "Review summary",
  markdown:
    "## Finding\n\n- **Guard** this input\n\n| Area | Status |\n| --- | --- |\n| Auth | Check |\n\n```ts\nconst safe = true\n```",
  fileRefs: [{ path: "src/auth.ts", line: 42, label: "Open validation" }],
  updatedAt: "2026-10-02T12:00:00.000Z",
}

describe("AnswerWindow", () => {
  it("renders_safe_markdown_and_opens_a_referenced_file", async () => {
    // Arrange
    const user = userEvent.setup()
    bridge.load.mockResolvedValue(REPORT)
    bridge.subscribe.mockResolvedValue(() => {})
    bridge.openFile.mockResolvedValue(undefined)
    render(<AnswerWindow sessionId={REPORT.sessionId} />)

    // Act
    await user.click(await screen.findByRole("button", { name: "Open validation:42" }))

    // Assert
    expect(screen.getByRole("heading", { name: "Finding" })).toBeInTheDocument()
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByText("const safe = true")).toBeInTheDocument()
    expect(bridge.openFile).toHaveBeenCalledWith(REPORT.sessionId, "src/auth.ts")
  })

  it("keeps_a_newer_event_when_the_initial_snapshot_arrives_late", async () => {
    // Arrange
    const deferred = {
      resolveInitial: null as ((report: typeof REPORT) => void) | null,
      onReport: null as ((report: typeof REPORT) => void) | null,
    }
    bridge.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.resolveInitial = resolve
        })
    )
    bridge.subscribe.mockImplementation(
      async (_sessionId: string, handler: (report: typeof REPORT) => void) => {
        deferred.onReport = handler
        return () => {}
      }
    )
    render(<AnswerWindow sessionId={REPORT.sessionId} />)
    const newerReport = { ...REPORT, title: "Newer answer" }

    // Act
    await waitFor(() => expect(deferred.onReport).not.toBeNull())
    await act(async () => {
      deferred.onReport!(newerReport)
      deferred.resolveInitial!(REPORT)
    })

    // Assert
    expect(await screen.findByRole("heading", { name: "Newer answer" })).toBeInTheDocument()
  })
})
