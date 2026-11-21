import { describe, expect, it } from "vitest"

import { declarationOf } from "@/test/cssDeclaration"

import stylesheet from "./AppShell.module.css?raw"

type ShellFrame = { height: string | null; position: string | null; overflow: string | null }

describe("app shell", () => {
  // A screen-reader-only label in a scrolled-away tray row once escaped its pane, made the page
  // taller than the window, and a scroll shifted the whole app up over an empty strip.
  it("app panes fill the window height", () => {
    // Arrange
    const shellRoot = ".root"

    // Act
    const frame: ShellFrame = {
      height: declarationOf(stylesheet, shellRoot, "height"),
      position: declarationOf(stylesheet, shellRoot, "position"),
      overflow: declarationOf(stylesheet, shellRoot, "overflow"),
    }

    // Assert
    const expected: ShellFrame = { height: "100vh", position: "relative", overflow: "clip" }
    expect(frame).toEqual(expected)
  })
})
