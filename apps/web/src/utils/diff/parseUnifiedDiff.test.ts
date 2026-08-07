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

  it("skips the local-git file header so /dev/null never renders as a diff row", () => {
    // Arrange — a local `git diff` patch for an added file, headers included (the
    // GitHub API strips these; the desktop's local git does not).
    const localGitPatch = [
      "diff --git a/pkg/entity/brandscan.go b/pkg/entity/brandscan.go",
      "new file mode 100644",
      "index 0000000..3b2e19a",
      "--- /dev/null",
      "+++ b/pkg/entity/brandscan.go",
      "@@ -0,0 +1,2 @@",
      "+package entity",
      "+",
    ].join("\n")

    // Act
    const parsed = parseUnifiedDiff(localGitPatch)
    const contents = parsed.lines.map((line) => line.content)

    // Assert — only the hunk header and the two added lines survive; no header row
    // (the "-- /dev/null" / "++ b/…" artifacts) leaks into the rendered diff.
    const expected = ["@@ -0,0 +1,2 @@", "package entity", ""]
    expect(contents).toEqual(expected)
    expect(parsed.lines[1]!.newLine).toBe(1)
  })

  it("keeps base and head numbering independent across a modify hunk", () => {
    // Arrange — http.ts: two hunks, each one deletion then two additions closed by a context
    // line. The SECOND hunk is where the two sides have drifted apart (base 9 answers head 11),
    // which is exactly the independence this pins.
    const patch = pr42Patches["src/types/http.ts"]!

    // Act
    const parsed = parseUnifiedDiff(patch)
    const deleted = parsed.lines.filter((line) => line.kind === "del")
    const added = parsed.lines.filter((line) => line.kind === "add")

    // Assert
    const expectedDeletedBaseLines = [3, 9]
    const expectedAddedHeadLines = [3, 4, 10, 11]
    expect(deleted.map((line) => line.oldLine)).toEqual(expectedDeletedBaseLines)
    expect(deleted.every((line) => line.newLine === null)).toBe(true)
    expect(added.map((line) => line.newLine)).toEqual(expectedAddedHeadLines)
  })

  it("treats an empty in-hunk line as blank context, keeping head numbering in sync", () => {
    // Arrange — GitHub-served patches can strip the trailing space from blank context
    // lines; skipping such a line desyncs every following head line number (and with
    // it the §10 symbol anchors). Line 3 here is fully empty, not " ".
    const patchWithBareBlankLine = [
      "@@ -1,5 +1,7 @@",
      "-// old comment",
      "+// new comment",
      "+import { withRateLimit } from './withRateLimit'",
      "",
      " export function loginHandler() {",
      "-  return null",
      "+  const guarded = withRateLimit(() => null)",
      "+  return guarded()",
      " }",
      "",
    ].join("\n")

    // Act
    const parsed = parseUnifiedDiff(patchWithBareBlankLine)
    const blankContext = parsed.lines.filter(
      (line) => line.kind === "context" && line.content === ""
    )
    const guardedLine = parsed.lines.find((line) =>
      line.content.includes("withRateLimit(() => null)")
    )

    // Assert — the empty line is context at head line 3, so the usage lands on head
    // line 5 (where the analysis occurrence points); the trailing artifact adds nothing.
    expect(blankContext).toHaveLength(1)
    expect(blankContext[0]!.newLine).toBe(3)
    expect(guardedLine!.newLine).toBe(5)
    expect(parsed.lines.at(-1)!.content).toBe("}")
  })
})
