import { describe, expect, it } from "vitest"

import { buildFullFileView } from "./fullFileView"
import { hideWhitespaceOnly } from "./hideWhitespaceOnly"
import { parseUnifiedDiff } from "./parseUnifiedDiff"
import {
  type SideBySideCell,
  type SideBySideRow,
  buildSideBySideRows,
  findRowForLineIndex,
} from "./sideBySideRows"

// Arranged from real patch strings (the reviewer reads the diff shape directly) and asserted
// against concrete typed SideBySideRow[] — so which line landed on which side, and which flat
// index it carries, is visible above the assert.

describe("buildSideBySideRows", () => {
  it("pairs a context line onto both sides as the same cell", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,1 @@", " const kept = 1"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const contextCell: SideBySideCell = {
      line: { kind: "context", content: "const kept = 1", oldLine: 1, newLine: 1 },
      index: 1,
    }
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,1 +1,1 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      { kind: "pair", left: contextCell, right: contextCell },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("puts a balanced removal beside its replacement — removed left, added right", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,1 @@", "-const x = 1", "+const x = 2"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,1 +1,1 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      {
        kind: "pair",
        left: {
          line: { kind: "del", content: "const x = 1", oldLine: 1, newLine: null },
          index: 1,
        },
        right: {
          line: { kind: "add", content: "const x = 2", oldLine: null, newLine: 1 },
          index: 2,
        },
      },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("fills the head side with empty cells when 3 lines are removed and only 1 added", () => {
    // Arrange
    const patch = ["@@ -1,3 +1,1 @@", "-a()", "-b()", "-c()", "+abc()"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,3 +1,1 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      {
        kind: "pair",
        left: { line: { kind: "del", content: "a()", oldLine: 1, newLine: null }, index: 1 },
        right: { line: { kind: "add", content: "abc()", oldLine: null, newLine: 1 }, index: 4 },
      },
      {
        kind: "pair",
        left: { line: { kind: "del", content: "b()", oldLine: 2, newLine: null }, index: 2 },
        right: null,
      },
      {
        kind: "pair",
        left: { line: { kind: "del", content: "c()", oldLine: 3, newLine: null }, index: 3 },
        right: null,
      },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("fills the base side with empty cells when 1 line is removed and 3 added", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,3 @@", "-abc()", "+a()", "+b()", "+c()"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,1 +1,3 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      {
        kind: "pair",
        left: { line: { kind: "del", content: "abc()", oldLine: 1, newLine: null }, index: 1 },
        right: { line: { kind: "add", content: "a()", oldLine: null, newLine: 1 }, index: 2 },
      },
      {
        kind: "pair",
        left: null,
        right: { line: { kind: "add", content: "b()", oldLine: null, newLine: 2 }, index: 3 },
      },
      {
        kind: "pair",
        left: null,
        right: { line: { kind: "add", content: "c()", oldLine: null, newLine: 3 }, index: 4 },
      },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("leaves the base side empty for a pure-addition hunk", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,2 @@", " kept()", "+added()"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const keptCell: SideBySideCell = {
      line: { kind: "context", content: "kept()", oldLine: 1, newLine: 1 },
      index: 1,
    }
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,1 +1,2 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      { kind: "pair", left: keptCell, right: keptCell },
      {
        kind: "pair",
        left: null,
        right: { line: { kind: "add", content: "added()", oldLine: null, newLine: 2 }, index: 2 },
      },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("leaves the head side empty for a pure-deletion hunk", () => {
    // Arrange
    const patch = ["@@ -1,2 +1,1 @@", " kept()", "-removed()"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const keptCell: SideBySideCell = {
      line: { kind: "context", content: "kept()", oldLine: 1, newLine: 1 },
      index: 1,
    }
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,2 +1,1 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      { kind: "pair", left: keptCell, right: keptCell },
      {
        kind: "pair",
        left: { line: { kind: "del", content: "removed()", oldLine: 2, newLine: null }, index: 2 },
        right: null,
      },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("starts a fresh region per hunk, so a header never merges two change runs", () => {
    // Arrange — two hunks, each one del; the header between them must break the pairing.
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-first()",
      "@@ -9,1 +9,1 @@",
      "+second()",
      // prettier-ignore
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: SideBySideRow[] = [
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -1,1 +1,1 @@", oldLine: null, newLine: null },
          index: 0,
        },
      },
      {
        kind: "pair",
        left: { line: { kind: "del", content: "first()", oldLine: 1, newLine: null }, index: 1 },
        right: null,
      },
      {
        kind: "hunk",
        header: {
          line: { kind: "hunk", content: "@@ -9,1 +9,1 @@", oldLine: null, newLine: null },
          index: 2,
        },
      },
      {
        kind: "pair",
        left: null,
        right: { line: { kind: "add", content: "second()", oldLine: null, newLine: 9 }, index: 3 },
      },
    ]

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toEqual(expected)
  })

  it("pairs a whitespace-only collapse as one context row when chained after hideWhitespaceOnly", () => {
    // Arrange — the del/add pair collapses first, so the split view sees a single context line.
    const patch = ["@@ -1,3 +1,3 @@", " function f() {", "-  return 1", "+    return 1", " }"].join(
      "\n"
    )
    const parsed = hideWhitespaceOnly(parseUnifiedDiff(patch))
    const collapsedCell: SideBySideCell = {
      line: { kind: "context", content: "    return 1", oldLine: 2, newLine: 2, wsOnly: true },
      index: 2,
    }
    const expected: SideBySideRow = { kind: "pair", left: collapsedCell, right: collapsedCell }

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows[2]).toEqual(expected)
    // Four lines in, four rows out — the collapse left nothing to pair asymmetrically.
    expect(rows).toHaveLength(4)
  })

  it("pairs the whole head file when chained after buildFullFileView", () => {
    // Arrange — the patch touches only line 2; the full-file view adds the untouched lines around
    // it, and every one of those is a context line that must pair onto both sides.
    const patch = ["@@ -2,2 +2,2 @@", " const head = 1", "-const body = 0", "+const body = 2"].join(
      "\n"
    )
    const headText = ["const top = 0", "const head = 1", "const body = 2", "const tail = 4"].join(
      "\n"
    )
    const parsed = buildFullFileView(headText, parseUnifiedDiff(patch))
    const expectedRowCount = 4
    const expectedChangeRow: SideBySideRow = {
      kind: "pair",
      left: {
        line: { kind: "del", content: "const body = 0", oldLine: 3, newLine: null },
        index: 2,
      },
      right: {
        line: { kind: "add", content: "const body = 2", oldLine: null, newLine: 3 },
        index: 3,
      },
    }

    // Act
    const rows = buildSideBySideRows(parsed)

    // Assert
    expect(rows).toHaveLength(expectedRowCount)
    expect(rows[2]).toEqual(expectedChangeRow)
  })
})

describe("findRowForLineIndex", () => {
  it("finds the row holding an added line that pairing moved ahead of its flat neighbours", () => {
    // Arrange — 3 dels then 1 add: flat index 4 (the add) lands on row 1, beside the FIRST del.
    const patch = ["@@ -1,3 +1,1 @@", "-a()", "-b()", "-c()", "+abc()"].join("\n")
    const rows = buildSideBySideRows(parseUnifiedDiff(patch))
    const addedLineIndex = 4
    const expectedRowIndex = 1

    // Act
    const rowIndex = findRowForLineIndex(rows, addedLineIndex)

    // Assert
    expect(rowIndex).toBe(expectedRowIndex)
  })

  it("finds the row of a hunk header", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,1 @@", "-x()", "+y()"].join("\n")
    const rows = buildSideBySideRows(parseUnifiedDiff(patch))
    const headerLineIndex = 0
    const expectedRowIndex = 0

    // Act
    const rowIndex = findRowForLineIndex(rows, headerLineIndex)

    // Assert
    expect(rowIndex).toBe(expectedRowIndex)
  })

  it("answers -1 for a line index no row holds", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,1 @@", "-x()", "+y()"].join("\n")
    const rows = buildSideBySideRows(parseUnifiedDiff(patch))
    const missingLineIndex = 99
    const expectedRowIndex = -1

    // Act
    const rowIndex = findRowForLineIndex(rows, missingLineIndex)

    // Assert
    expect(rowIndex).toBe(expectedRowIndex)
  })
})
