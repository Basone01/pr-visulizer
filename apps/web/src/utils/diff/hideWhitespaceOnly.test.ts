import { describe, expect, it } from "vitest"

import type { DiffLine } from "@/entity/diff"

import { hideWhitespaceOnly } from "./hideWhitespaceOnly"
import { parseUnifiedDiff } from "./parseUnifiedDiff"

// The transform runs over parseUnifiedDiff output (§10). We arrange from real patch strings
// (the reviewer reads the diff shape directly) and assert against concrete typed DiffLine[]
// so every collapsed line's preserved base/head numbers are visible above the assert.

describe("hideWhitespaceOnly", () => {
  it("collapses an indentation-only change to one context line, keeping both line numbers", () => {
    // Arrange
    const patch = ["@@ -1,3 +1,3 @@", " function f() {", "-  return 1", "+    return 1", " }"].join(
      "\n"
    )
    const parsed = parseUnifiedDiff(patch)
    const expected: DiffLine[] = [
      { kind: "hunk", content: "@@ -1,3 +1,3 @@", oldLine: null, newLine: null },
      { kind: "context", content: "function f() {", oldLine: 1, newLine: 1 },
      { kind: "context", content: "    return 1", oldLine: 2, newLine: 2, wsOnly: true },
      { kind: "context", content: "}", oldLine: 3, newLine: 3 },
    ]

    // Act
    const result = hideWhitespaceOnly(parsed)

    // Assert
    expect(result.lines).toEqual(expected)
  })

  it("leaves a real content change untouched", () => {
    // Arrange
    const patch = ["@@ -1,1 +1,1 @@", "-const x = 1", "+const x = 2"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: DiffLine[] = [
      { kind: "hunk", content: "@@ -1,1 +1,1 @@", oldLine: null, newLine: null },
      { kind: "del", content: "const x = 1", oldLine: 1, newLine: null },
      { kind: "add", content: "const x = 2", oldLine: null, newLine: 1 },
    ]

    // Act
    const result = hideWhitespaceOnly(parsed)

    // Assert
    expect(result.lines).toEqual(expected)
  })

  it("collapses only the whitespace-only pair in a mixed hunk and keeps the real pair", () => {
    // Arrange — 2 dels / 2 adds; pair #1 is indentation-only, pair #2 is a real change.
    const patch = ["@@ -1,2 +1,2 @@", "-  a = 1", "-b = 2", "+a = 1", "+b = 3"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: DiffLine[] = [
      { kind: "hunk", content: "@@ -1,2 +1,2 @@", oldLine: null, newLine: null },
      { kind: "context", content: "a = 1", oldLine: 1, newLine: 1, wsOnly: true },
      { kind: "del", content: "b = 2", oldLine: 2, newLine: null },
      { kind: "add", content: "b = 3", oldLine: null, newLine: 2 },
    ]

    // Act
    const result = hideWhitespaceOnly(parsed)

    // Assert
    expect(result.lines).toEqual(expected)
  })

  it("keeps the unpaired add remainder when the add-block is longer than the del-block", () => {
    // Arrange — 1 del / 2 adds: pair #1 is whitespace-only, the extra add is real new content.
    const patch = ["@@ -1,1 +1,2 @@", "-  message", "+message", "+retryAfterSeconds"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: DiffLine[] = [
      { kind: "hunk", content: "@@ -1,1 +1,2 @@", oldLine: null, newLine: null },
      { kind: "context", content: "message", oldLine: 1, newLine: 1, wsOnly: true },
      { kind: "add", content: "retryAfterSeconds", oldLine: null, newLine: 2 },
    ]

    // Act
    const result = hideWhitespaceOnly(parsed)

    // Assert
    expect(result.lines).toEqual(expected)
  })

  it("does not renumber the lines that follow a collapsed pair", () => {
    // Arrange — a collapse at head line 11, then more lines that must keep their parsed numbers.
    const patch = [
      "@@ -10,3 +10,4 @@",
      " keep()",
      "-  x = 1",
      "+x = 1",
      " after()",
      "+added()",
    ].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: DiffLine[] = [
      { kind: "hunk", content: "@@ -10,3 +10,4 @@", oldLine: null, newLine: null },
      { kind: "context", content: "keep()", oldLine: 10, newLine: 10 },
      { kind: "context", content: "x = 1", oldLine: 11, newLine: 11, wsOnly: true },
      { kind: "context", content: "after()", oldLine: 12, newLine: 12 },
      { kind: "add", content: "added()", oldLine: null, newLine: 13 },
    ]

    // Act
    const result = hideWhitespaceOnly(parsed)

    // Assert
    expect(result.lines).toEqual(expected)
  })

  it("treats a trailing-whitespace-to-empty change as whitespace-only", () => {
    // Arrange — a line of spaces becomes empty; both normalize to "" so it is whitespace-only.
    const patch = ["@@ -1,3 +1,3 @@", " a", "-   ", "+", " b"].join("\n")
    const parsed = parseUnifiedDiff(patch)
    const expected: DiffLine[] = [
      { kind: "hunk", content: "@@ -1,3 +1,3 @@", oldLine: null, newLine: null },
      { kind: "context", content: "a", oldLine: 1, newLine: 1 },
      { kind: "context", content: "", oldLine: 2, newLine: 2, wsOnly: true },
      { kind: "context", content: "b", oldLine: 3, newLine: 3 },
    ]

    // Act
    const result = hideWhitespaceOnly(parsed)

    // Assert
    expect(result.lines).toEqual(expected)
  })
})
