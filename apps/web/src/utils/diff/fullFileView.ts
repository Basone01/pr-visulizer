import type { DiffLine, ParsedDiff } from "@/entity/diff"

import { parseHunkHeader } from "./parseUnifiedDiff"

// The full-file view transform (§10): the same parsed patch, re-rendered over the WHOLE head
// file instead of just its hunks. The patch stays authoritative inside a hunk (its content and
// both line numbers are used verbatim); the head text only fills the unchanged gaps BETWEEN
// hunks. So a head line keeps the exact `newLine` the hunks-only view gave it — symbol anchors,
// drafts and find all key off newLine and keep resolving when the toggle flips.
//
// Deleted lines carry no head line, so they stay exactly where the patch put them: right before
// the head line that follows them (including a run that falls off the end of the file).
// Hunk headers are dropped — a contiguous file has nothing to separate.

// Same trailing-newline artifact the parser drops, so a file ending in "\n" doesn't gain a
// phantom blank last line.
function headLinesOf(headText: string): string[] {
  const lines = headText.split("\n")
  if (lines.at(-1) === "") lines.pop()

  return lines
}

export function buildFullFileView(headText: string, parsed: ParsedDiff): ParsedDiff {
  const headLines = headLinesOf(headText)
  const lines: DiffLine[] = []

  // The next head line to emit, and the base number it would carry if unchanged.
  let headLine = 1
  let oldLine = 1

  // Emit the untouched head lines between the last thing we wrote and `untilHeadLine`.
  function fillGapBefore(untilHeadLine: number): void {
    while (headLine < untilHeadLine && headLine <= headLines.length) {
      lines.push({ kind: "context", content: headLines[headLine - 1]!, oldLine, newLine: headLine })
      headLine += 1
      oldLine += 1
    }
  }

  for (const line of parsed.lines) {
    if (line.kind === "hunk") {
      const hunk = parseHunkHeader(line.content)
      if (!hunk) continue

      fillGapBefore(hunk.newStart)
      // Re-sync the base counter to the patch: the gap fill only tracked head lines, and an
      // earlier hunk may have changed how far the two sides have drifted apart.
      oldLine = hunk.oldStart
      continue
    }

    if (line.kind === "del") {
      lines.push(line)
      oldLine = (line.oldLine ?? oldLine) + 1
      continue
    }

    lines.push(line)
    if (line.newLine !== null) headLine = line.newLine + 1
    if (line.oldLine !== null) oldLine = line.oldLine + 1
  }

  fillGapBefore(headLines.length + 1)

  return { lines }
}
