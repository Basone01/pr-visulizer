import type { DiffLine, ParsedDiff } from "@/entity/diff"

// A view-layer transform over parseUnifiedDiff output (docs/architecture.md §10). Within a
// hunk it pairs each del-block line with the add-block line at the same position (1st del
// with 1st add, …); a pair that is equal after whitespace normalization is a whitespace-only
// change and collapses to a single context-style line. Unpaired remainders stay untouched.
//
// It NEVER renumbers: every emitted line keeps the base/head number the parser assigned, and
// a collapsed line reuses the del's base number and the add's head number. So symbol anchors
// (§10, keyed by head line) still resolve on every following line.

// The whitespace rule, kept deliberately simple: collapse every run of spaces/tabs to a single
// space and trim both ends, then compare. This hides indentation changes, trailing spaces, and
// changes to the run-length of inner spacing — and nothing else. Whitespace inside string or
// comment text is treated the same as any other whitespace (no special-casing), so a re-indent
// that also touches a string literal's spacing is still counted as whitespace-only.
function normalizeWhitespace(content: string): string {
  return content.replace(/[ \t]+/g, " ").trim()
}

function isWhitespaceOnlyPair(del: DiffLine, add: DiffLine): boolean {
  return normalizeWhitespace(del.content) === normalizeWhitespace(add.content)
}

// The collapsed line shows the HEAD (add) content but carries BOTH line numbers, so it reads
// as an unchanged context line yet keeps the base number visible. Tagged wsOnly for styling.
function collapsePair(del: DiffLine, add: DiffLine): DiffLine {
  return {
    kind: "context",
    content: add.content,
    oldLine: del.oldLine,
    newLine: add.newLine,
    wsOnly: true,
  }
}

// Reconcile one del-block / add-block region. When no pair is whitespace-only, return the region
// exactly as parsed (identity) — a hunk of real changes never reorders when the toggle flips.
function reconcileRegion(dels: DiffLine[], adds: DiffLine[]): DiffLine[] {
  const pairCount = Math.min(dels.length, adds.length)

  let hasWhitespaceOnlyPair = false
  for (let index = 0; index < pairCount; index += 1) {
    if (isWhitespaceOnlyPair(dels[index]!, adds[index]!)) {
      hasWhitespaceOnlyPair = true
      break
    }
  }

  if (!hasWhitespaceOnlyPair) return [...dels, ...adds]

  const merged: DiffLine[] = []

  for (let index = 0; index < pairCount; index += 1) {
    const del = dels[index]!
    const add = adds[index]!

    if (isWhitespaceOnlyPair(del, add)) {
      merged.push(collapsePair(del, add))
      continue
    }

    merged.push(del, add)
  }

  // Unpaired remainders — a longer del- or add-block — are real content, kept as-is.
  merged.push(...dels.slice(pairCount), ...adds.slice(pairCount))

  return merged
}

export function hideWhitespaceOnly(parsed: ParsedDiff): ParsedDiff {
  const { lines } = parsed
  const out: DiffLine[] = []

  let index = 0
  while (index < lines.length) {
    const line = lines[index]!

    if (line.kind !== "del") {
      out.push(line)
      index += 1
      continue
    }

    // Gather the maximal del-block, then the add-block that immediately follows it.
    const dels: DiffLine[] = []
    while (index < lines.length && lines[index]!.kind === "del") {
      dels.push(lines[index]!)
      index += 1
    }

    const adds: DiffLine[] = []
    while (index < lines.length && lines[index]!.kind === "add") {
      adds.push(lines[index]!)
      index += 1
    }

    out.push(...reconcileRegion(dels, adds))
  }

  return { lines: out }
}
