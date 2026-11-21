import { describe, expect, it } from "vitest"

import { hideWhitespaceOnly } from "./hideWhitespaceOnly"
import { parseUnifiedDiff } from "./parseUnifiedDiff"
import { type ChangeKind, type LineRange, type SplitView, buildSplitView } from "./splitBlocks"

// The promise: each changed block on the LEFT is paired with the RIGHT block it became,
// including a pure insertion (empty left range at the insertion point) and a pure deletion.
// Arranged from real patch strings and asserted as the text each block covers on each side,
// so the pairing reads like the diff itself.

type BlockReading = {
  kind: ChangeKind
  left: LineRange
  right: LineRange
  before: string[]
  after: string[]
}

function readBlocks(view: SplitView): BlockReading[] {
  return view.blocks.map((block) => ({
    ...block,
    before: view.left.slice(block.left.start, block.left.end).map((cell) => cell.line.content),
    after: view.right.slice(block.right.start, block.right.end).map((cell) => cell.line.content),
  }))
}

describe("buildSplitView — each left block is paired with the right block it became", () => {
  it("pairs the reference screenshot: an inserted line, then a modified line", () => {
    // Arrange — lines 4..5 -> 4..6 of the JetBrains reference.
    const patch = [
      "@@ -4,2 +4,3 @@",
      " /// Responsible for storing the frames of a single GIF.",
      "-class FrameStore {",
      "+@MainActor",
      "+final class FrameStore: Sendable {",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const blocks = readBlocks(buildSplitView(parsed))

    // Assert — left index 2 is the insertion point BETWEEN the doc comment and `class FrameStore`.
    const expected: BlockReading[] = [
      {
        kind: "inserted",
        left: { start: 2, end: 2 },
        right: { start: 2, end: 3 },
        before: [],
        after: ["@MainActor"],
      },
      {
        kind: "modified",
        left: { start: 2, end: 3 },
        right: { start: 3, end: 4 },
        before: ["class FrameStore {"],
        after: ["final class FrameStore: Sendable {"],
      },
    ]
    expect(blocks).toEqual(expected)
  })

  it("pairs a pure deletion with an empty right range at the point it was removed", () => {
    // Arrange
    const patch = [
      "@@ -1,3 +1,2 @@",
      " const kept = 1",
      "-const removed = 2",
      " const after = 3",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const blocks = readBlocks(buildSplitView(parsed))

    // Assert
    const expected: BlockReading[] = [
      {
        kind: "deleted",
        left: { start: 2, end: 3 },
        right: { start: 2, end: 2 },
        before: ["const removed = 2"],
        after: [],
      },
    ]
    expect(blocks).toEqual(expected)
  })

  it("pairs a pure insertion with an empty left range at the point it was added", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,3 @@", " const kept = 1", "+const a = 2", "+const b = 3"].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const blocks = readBlocks(buildSplitView(parsed))

    // Assert
    const expected: BlockReading[] = [
      {
        kind: "inserted",
        left: { start: 2, end: 2 },
        right: { start: 2, end: 4 },
        before: [],
        after: ["const a = 2", "const b = 3"],
      },
    ]
    expect(blocks).toEqual(expected)
  })

  it("pairs one modified line with two lines of different count as one rewrite block", () => {
    // Arrange — nothing on the right is similar enough to pair with the removed line.
    const patch = [
      "@@ -1,1 +1,2 @@",
      "-return total",
      "+const sum = items.reduce(add, 0)",
      "+console.log(sum)",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const blocks = readBlocks(buildSplitView(parsed))

    // Assert
    const expected: BlockReading[] = [
      {
        kind: "modified",
        left: { start: 1, end: 2 },
        right: { start: 1, end: 3 },
        before: ["return total"],
        after: ["const sum = items.reduce(add, 0)", "console.log(sum)"],
      },
    ]
    expect(blocks).toEqual(expected)
  })

  it("keeps two consecutive similar pairs together as one modified block", () => {
    // Arrange
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-const width = 10",
      "-const height = 20",
      "+const width = 12",
      "+const height = 24",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const blocks = readBlocks(buildSplitView(parsed))

    // Assert
    const expected: BlockReading[] = [
      {
        kind: "modified",
        left: { start: 1, end: 3 },
        right: { start: 1, end: 3 },
        before: ["const width = 10", "const height = 20"],
        after: ["const width = 12", "const height = 24"],
      },
    ]
    expect(blocks).toEqual(expected)
  })

  it("pairs blocks across two hunks against the right offsets on each side", () => {
    // Arrange — the first hunk adds a line, so every later right index is one ahead of its left.
    const patch = [
      "@@ -1,1 +1,2 @@",
      " import a",
      "+import b",
      "@@ -9,1 +10,1 @@",
      "-export const x = 1",
      "+export const x = 2",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const blocks = readBlocks(buildSplitView(parsed))

    // Assert
    const expected: BlockReading[] = [
      {
        kind: "inserted",
        left: { start: 2, end: 2 },
        right: { start: 2, end: 3 },
        before: [],
        after: ["import b"],
      },
      {
        kind: "modified",
        left: { start: 3, end: 4 },
        right: { start: 4, end: 5 },
        before: ["export const x = 1"],
        after: ["export const x = 2"],
      },
    ]
    expect(blocks).toEqual(expected)
  })

  it("puts context and hunk lines on both sides with their flat index, and no filler", () => {
    // Arrange
    const patch = ["@@ -1,2 +1,1 @@", " const kept = 1", "-const removed = 2"].join("\n")
    const parsed = parseUnifiedDiff(patch)

    // Act
    const view = buildSplitView(parsed)

    // Assert
    const expected = { left: [0, 1, 2], right: [0, 1] }
    expect({
      left: view.left.map((cell) => cell.index),
      right: view.right.map((cell) => cell.index),
    }).toEqual(expected)
  })

  it("reads the line list hide-whitespace produced, so a whitespace-only pair is no block", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,1 @@", "-  const x = 1", "+    const x = 1"].join("\n")
    const parsed = hideWhitespaceOnly(parseUnifiedDiff(patch))

    // Act
    const view = buildSplitView(parsed)

    // Assert
    const expected: BlockReading[] = []
    expect(readBlocks(view)).toEqual(expected)
  })
})
