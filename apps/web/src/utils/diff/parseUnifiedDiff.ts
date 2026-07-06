import type { DiffLine, ParsedDiff } from "@/entity/diff"

// Our own unified-diff walker (docs/architecture.md §10): the parse is a pure,
// separate layer from syntax highlighting, so the two never fight. It feeds line
// spans + head line numbers; shiki colors the text, diff status colors the row.

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

// Parse a single file's unified-diff patch (the `patch` field GitHub returns).
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const lines: DiffLine[] = []

  // Head/base line counters, advanced as we walk each hunk.
  let oldLine = 0
  let newLine = 0

  // Drop the final-split artifact of a trailing newline so it can't render as a
  // phantom blank context line.
  const rawLines = patch.split("\n")
  if (rawLines.at(-1) === "") rawLines.pop()

  for (const raw of rawLines) {
    const header = HUNK_HEADER.exec(raw)

    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      lines.push({ kind: "hunk", content: raw, oldLine: null, newLine: null })
      continue
    }

    // "No newline at end of file" markers carry no line — skip them.
    if (raw.startsWith("\\")) continue

    const marker = raw[0]
    const content = raw.slice(1)

    if (marker === "+") {
      lines.push({ kind: "add", content, oldLine: null, newLine })
      newLine += 1
      continue
    }

    if (marker === "-") {
      lines.push({ kind: "del", content, oldLine, newLine: null })
      oldLine += 1
      continue
    }

    // A leading space is a context line. A fully empty line inside a hunk is a blank
    // context line whose trailing space got stripped (GitHub-served patches do this) —
    // skipping it would desync every following line number, so treat it as context too.
    // Empty strings before any hunk header (or the final-split artifact) carry no line.
    const inHunk = oldLine > 0 || newLine > 0
    if (marker === " " || (raw === "" && inHunk)) {
      lines.push({ kind: "context", content, oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }

  return { lines }
}
