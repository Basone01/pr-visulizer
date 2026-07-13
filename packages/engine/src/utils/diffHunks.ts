// Parse the head-side line ranges a unified-diff patch touches
// (docs/architecture.md §5 step 5). We only need the hunk HEADERS, never the body:
// `@@ -a,b +c,d @@` means the head version changed lines [c, c + d).

export type LineRange = {
  startLine: number // 1-based, inclusive
  endLine: number // 1-based, inclusive
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

// Extract each hunk's head range. A header without an explicit count (`+c`) means
// a single line (count defaults to 1).
export function headHunkRanges(patch: string | null | undefined): LineRange[] {
  if (!patch) return []

  const ranges: LineRange[] = []

  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line)
    if (!match) continue

    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])

    // A pure deletion (count 0) still anchors at `start`; treat it as one line so
    // an intersection test never yields an empty, un-matchable range.
    const span = count === 0 ? 1 : count
    ranges.push({ startLine: start, endLine: start + span - 1 })
  }

  return ranges
}

// Do two inclusive 1-based ranges overlap? Powers "symbol span intersects a hunk".
export function rangesIntersect(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine
}
