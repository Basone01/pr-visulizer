// The single changed span between two lines: everything between their common prefix and their
// common suffix. Cheap (linear), so it is the fallback wherever the word-level match is too costly.

// Half-open [start, end) over a line's content, in UTF-16 code units — the units String.slice
// takes, so the renderer cuts tokens with it directly.
export type CharRange = { start: number; end: number }

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

// A common prefix that ends on a high surrogate would cut an astral character (an emoji in a
// string literal) in half, and half a pair renders as a replacement glyph — step back one unit.
function commonPrefixLength(before: string, after: string): number {
  const limit = Math.min(before.length, after.length)

  let length = 0
  while (length < limit && before[length] === after[length]) length += 1

  if (length > 0 && isHighSurrogate(before.charCodeAt(length - 1))) return length - 1

  return length
}

// `limit` keeps the suffix from reaching back into the prefix — without it "aaa" -> "aaaa" would
// claim the same characters twice and produce a negative-width range.
function commonSuffixLength(before: string, after: string, limit: number): number {
  let length = 0
  while (
    length < limit &&
    before[before.length - 1 - length] === after[after.length - 1 - length]
  ) {
    length += 1
  }

  // The suffix starts on a low surrogate whose high half is outside it — same split, same fix.
  if (length > 0 && isLowSurrogate(before.charCodeAt(before.length - length))) return length - 1

  return length
}

export type PairRanges = {
  before: CharRange
  after: CharRange
  // How much of the longer line the change covers, 0..1 — the similarity measure the alignment
  // below ranks candidates by, and the same number the emphasis threshold reads.
  changedFraction: number
}

// Everything between the common prefix and the common suffix changed. null means the two lines
// are IDENTICAL — nothing to emphasize, and a perfect counterpart as far as pairing is concerned.
export function changedRangesForPair(before: string, after: string): PairRanges | null {
  if (before === after) return null

  const prefix = commonPrefixLength(before, after)
  const suffixLimit = Math.min(before.length, after.length) - prefix
  const suffix = commonSuffixLength(before, after, suffixLimit)

  const beforeChanged: CharRange = { start: prefix, end: before.length - suffix }
  const afterChanged: CharRange = { start: prefix, end: after.length - suffix }

  const longestLine = Math.max(before.length, after.length)
  const longestChange = Math.max(
    beforeChanged.end - beforeChanged.start,
    afterChanged.end - afterChanged.start
  )

  return {
    before: beforeChanged,
    after: afterChanged,
    changedFraction: longestChange / longestLine,
  }
}
