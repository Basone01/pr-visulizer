import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RecentFilesPalette } from "./RecentFilesPalette"

// The ⌘P switcher, driven exactly as a reviewer drives it: hold the modifier, tap P to walk the
// recent list, release to open. Typing turns the same palette into a fuzzy search over the PR.

const RECENT_FILES = ["src/routes/login.ts", "src/auth/token.ts", "src/config/env.ts"]

const FILE_PATHS = [
  "src/routes/login.ts",
  "src/auth/token.ts",
  "src/auth/tokenStore.ts",
  "src/config/env.ts",
]

function pressSwitcherChord(shiftKey = false): void {
  fireEvent.keyDown(document.body, { key: "p", metaKey: true, shiftKey })
}

function releaseMetaKey(): void {
  fireEvent.keyUp(document.body, { key: "Meta" })
}

// A row shows the file name and its folder as two spans, so the full path is read from the
// tooltip the row already carries rather than reassembled from its text.
function selectedPaths(): string[] {
  return screen
    .getAllByRole("option")
    .filter((option) => option.getAttribute("aria-selected") === "true")
    .map((option) => option.getAttribute("title") ?? "")
}

describe("RecentFilesPalette", () => {
  it("opens on the switcher chord with the second recent file highlighted", () => {
    // Arrange
    const onOpenFile = vi.fn()
    render(
      <RecentFilesPalette
        recentFiles={RECENT_FILES}
        filePaths={FILE_PATHS}
        onOpenFile={onOpenFile}
      />
    )

    // Act
    pressSwitcherChord()

    // Assert — row 0 is the file already open, so the switcher lands on the one before it.
    const expected = ["src/auth/token.ts"]
    expect(screen.getByRole("dialog", { name: "Recent files" })).toBeInTheDocument()
    expect(selectedPaths()).toEqual(expected)
  })

  it("walks the highlight down on a repeated chord and wraps past the last row", () => {
    // Arrange
    const onOpenFile = vi.fn()
    render(
      <RecentFilesPalette
        recentFiles={RECENT_FILES}
        filePaths={FILE_PATHS}
        onOpenFile={onOpenFile}
      />
    )
    pressSwitcherChord()

    // Act — from row 1 to row 2, then around to row 0.
    pressSwitcherChord()
    const afterSecondChord = selectedPaths()
    pressSwitcherChord()

    // Assert
    const expectedAfterSecondChord = ["src/config/env.ts"]
    const expectedAfterWrap = ["src/routes/login.ts"]
    expect(afterSecondChord).toEqual(expectedAfterSecondChord)
    expect(selectedPaths()).toEqual(expectedAfterWrap)
  })

  it("walks the highlight up on the shifted chord and on ArrowUp", () => {
    // Arrange
    const onOpenFile = vi.fn()
    const shiftKey = true
    render(
      <RecentFilesPalette
        recentFiles={RECENT_FILES}
        filePaths={FILE_PATHS}
        onOpenFile={onOpenFile}
      />
    )
    pressSwitcherChord()

    // Act — row 1 up to row 0, then ArrowDown/ArrowUp back over the same step.
    pressSwitcherChord(shiftKey)
    const afterShiftedChord = selectedPaths()
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    fireEvent.keyDown(document.body, { key: "ArrowUp" })

    // Assert
    const expected = ["src/routes/login.ts"]
    expect(afterShiftedChord).toEqual(expected)
    expect(selectedPaths()).toEqual(expected)
  })

  it("opens the highlighted file when the modifier is released", () => {
    // Arrange
    const onOpenFile = vi.fn()
    render(
      <RecentFilesPalette
        recentFiles={RECENT_FILES}
        filePaths={FILE_PATHS}
        onOpenFile={onOpenFile}
      />
    )
    pressSwitcherChord()

    // Act
    releaseMetaKey()

    // Assert
    const expectedPath = "src/auth/token.ts"
    expect(onOpenFile).toHaveBeenCalledWith(expectedPath)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("closes on Escape without switching files", () => {
    // Arrange
    const onOpenFile = vi.fn()
    render(
      <RecentFilesPalette
        recentFiles={RECENT_FILES}
        filePaths={FILE_PATHS}
        onOpenFile={onOpenFile}
      />
    )
    pressSwitcherChord()

    // Act
    fireEvent.keyDown(document.body, { key: "Escape" })

    // Assert
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it("searches every file in the PR once the reviewer types, and Enter opens the highlight", () => {
    // Arrange — env.ts was never viewed, so only the search can reach it.
    const onOpenFile = vi.fn()
    const query = "env"
    render(
      <RecentFilesPalette
        recentFiles={["src/routes/login.ts"]}
        filePaths={FILE_PATHS}
        onOpenFile={onOpenFile}
      />
    )
    pressSwitcherChord()

    // Act
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: query } })
    const highlighted = selectedPaths()
    const matchedChars = screen.getAllByRole("option")[0]!.querySelectorAll("mark").length
    releaseMetaKey()
    const openedOnModifierRelease = onOpenFile.mock.calls.length
    fireEvent.keyDown(document.body, { key: "Enter" })

    // Assert — the matched characters are marked, a stray modifier release no longer commits
    // (the reviewer let go of it to type), and Enter opens the highlighted row.
    const expectedPath = "src/config/env.ts"
    const expectedMarkedChars = query.length
    const expectedOpensOnModifierRelease = 0
    expect(highlighted).toEqual([expectedPath])
    expect(matchedChars).toBe(expectedMarkedChars)
    expect(openedOnModifierRelease).toBe(expectedOpensOnModifierRelease)
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenFile).toHaveBeenCalledWith(expectedPath)
  })

  it("stays closed when there is nothing to switch to and nothing to search", () => {
    // Arrange
    const onOpenFile = vi.fn()
    const noRecentFiles: string[] = []
    const noFilePaths: string[] = []
    render(
      <RecentFilesPalette
        recentFiles={noRecentFiles}
        filePaths={noFilePaths}
        onOpenFile={onOpenFile}
      />
    )

    // Act
    pressSwitcherChord()

    // Assert
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
