import { describe, expect, it } from "vitest"

import type { DiffLine } from "@/entity/diff"

import { buildFullFileView } from "./fullFileView"
import { parseUnifiedDiff } from "./parseUnifiedDiff"

// The full-file view (§10): every head line rendered, changed lines still marked, deleted runs
// interleaved at their anchor. The head numbering must match the hunks-only view line for line —
// symbol anchors, drafts and find all key off newLine.

describe("buildFullFileView", () => {
  it("renders the unchanged lines around a hunk as context", () => {
    // Arrange
    const headText = ["const a = 1", "const b = 2", "const c = 3", "const d = 4"].join("\n")
    const patch = [
      "@@ -2,3 +2,3 @@",
      " const b = 2",
      "-const c = 0",
      "+const c = 3",
      " const d = 4",
    ].join("\n")
    const expected: DiffLine[] = [
      { kind: "context", content: "const a = 1", oldLine: 1, newLine: 1 },
      { kind: "context", content: "const b = 2", oldLine: 2, newLine: 2 },
      { kind: "del", content: "const c = 0", oldLine: 3, newLine: null },
      { kind: "add", content: "const c = 3", oldLine: null, newLine: 3 },
      { kind: "context", content: "const d = 4", oldLine: 4, newLine: 4 },
    ]

    // Act
    const view = buildFullFileView(headText, parseUnifiedDiff(patch))

    // Assert
    expect(view.lines).toEqual(expected)
  })

  it("emits no hunk separator rows", () => {
    // Arrange
    const headText = ["const a = 1", "const b = 2"].join("\n")
    const patch = ["@@ -1,2 +1,2 @@", " const a = 1", "-const b = 0", "+const b = 2"].join("\n")
    const expectedHunkRows = 0

    // Act
    const view = buildFullFileView(headText, parseUnifiedDiff(patch))

    // Assert
    expect(view.lines.filter((line) => line.kind === "hunk")).toHaveLength(expectedHunkRows)
  })

  it("marks every line of an added file as an addition", () => {
    // Arrange
    const headText = ["export const x = 1", "export const y = 2"].join("\n")
    const patch = ["@@ -0,0 +1,2 @@", "+export const x = 1", "+export const y = 2"].join("\n")
    const expected: DiffLine[] = [
      { kind: "add", content: "export const x = 1", oldLine: null, newLine: 1 },
      { kind: "add", content: "export const y = 2", oldLine: null, newLine: 2 },
    ]

    // Act
    const view = buildFullFileView(headText, parseUnifiedDiff(patch))

    // Assert
    expect(view.lines).toEqual(expected)
  })

  it("interleaves a deleted run at its anchor and keeps base numbering after it", () => {
    // Arrange
    const headText = ["line one", "line four", "line five"].join("\n")
    const patch = ["@@ -1,4 +1,2 @@", " line one", "-line two", "-line three", " line four"].join(
      "\n"
    )
    const expected: DiffLine[] = [
      { kind: "context", content: "line one", oldLine: 1, newLine: 1 },
      { kind: "del", content: "line two", oldLine: 2, newLine: null },
      { kind: "del", content: "line three", oldLine: 3, newLine: null },
      { kind: "context", content: "line four", oldLine: 4, newLine: 2 },
      // Past the hunk: the head tail is unchanged, so base numbering keeps counting from 5.
      { kind: "context", content: "line five", oldLine: 5, newLine: 3 },
    ]

    // Act
    const view = buildFullFileView(headText, parseUnifiedDiff(patch))

    // Assert
    expect(view.lines).toEqual(expected)
  })

  it("keeps a deleted run that runs off the end of the head file", () => {
    // Arrange
    const headText = ["kept one", "kept two"].join("\n")
    const patch = [
      "@@ -1,4 +1,2 @@",
      " kept one",
      " kept two",
      "-dropped three",
      "-dropped four",
    ].join("\n")
    const expected: DiffLine[] = [
      { kind: "context", content: "kept one", oldLine: 1, newLine: 1 },
      { kind: "context", content: "kept two", oldLine: 2, newLine: 2 },
      { kind: "del", content: "dropped three", oldLine: 3, newLine: null },
      { kind: "del", content: "dropped four", oldLine: 4, newLine: null },
    ]

    // Act
    const view = buildFullFileView(headText, parseUnifiedDiff(patch))

    // Assert
    expect(view.lines).toEqual(expected)
  })

  it("keeps the head line numbers the hunks-only view assigned", () => {
    // Arrange — anchors, drafts and find all key off newLine, so the two views must agree on it.
    const headText = ["import a", "", "const b = 2", "const c = 3"].join("\n")
    const patch = ["@@ -3,1 +3,2 @@", "-const b = 1", "+const b = 2", "+const c = 3"].join("\n")
    const hunksView = parseUnifiedDiff(patch)
    const expectedHeadLines = hunksView.lines
      .filter((line) => line.kind === "add")
      .map((line) => line.newLine)

    // Act
    const view = buildFullFileView(headText, hunksView)

    // Assert
    expect(view.lines.filter((line) => line.kind === "add").map((line) => line.newLine)).toEqual(
      expectedHeadLines
    )
  })
})
