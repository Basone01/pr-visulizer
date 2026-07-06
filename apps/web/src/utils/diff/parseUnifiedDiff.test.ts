import { describe, expect, it } from "vitest"

import { pr42Patches } from "@/service/fixture/patches"

import { parseUnifiedDiff } from "./parseUnifiedDiff"

// The diff walker feeds head line numbers to the anchor overlay (§10). Added lines
// carry a head line, deleted lines a base line, context both.

describe("parseUnifiedDiff", () => {
  it("numbers added lines by their head position", () => {
    // Arrange
    const patch = pr42Patches["src/middleware/withRateLimit.ts"]!

    // Act
    const parsed = parseUnifiedDiff(patch)
    const added = parsed.lines.filter((line) => line.kind === "add")

    // Assert — 16 added lines, first at head line 1, last at head line 16.
    expect(added).toHaveLength(16)
    expect(added[0]!.newLine).toBe(1)
    expect(added[15]!.newLine).toBe(16)
  })

  it("keeps base and head numbering independent across a modify hunk", () => {
    // Arrange — http.ts: one deletion then two additions inside a context block.
    const patch = pr42Patches["src/types/http.ts"]!

    // Act
    const parsed = parseUnifiedDiff(patch)
    const deleted = parsed.lines.filter((line) => line.kind === "del")
    const added = parsed.lines.filter((line) => line.kind === "add")

    // Assert
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.oldLine).toBe(3)
    expect(deleted[0]!.newLine).toBeNull()
    expect(added.map((line) => line.newLine)).toEqual([3, 4])
  })
})
