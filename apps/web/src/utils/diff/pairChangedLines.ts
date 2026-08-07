// Which removed line answers which added line, inside one del-run/add-run region (§10).
//
// A unified diff hands over two RUNS, not pairs: `-a -b +x +y`. Reading them positionally — 1st
// del with 1st add — is right whenever the two runs describe the same lines in the same order,
// and wrong the moment an unrelated line is inserted among the adds: a hunk that deletes one line
// and adds a comment ABOVE its replacement then pairs the deleted line with the comment, finds
// them unrelated, and gives up — so the line that really did change gets no character-level
// emphasis at all. That is the bug this module exists to fix, and it is why GitHub aligns by
// similarity rather than by position.
//
// Pure and framework-free, and deliberately shared: the intra-line emphasis and the side-by-side
// view both have to agree on what "a pair" is, or the split view puts a removed line across from
// a line its own emphasis says it has nothing to do with.

// Half-open [start, end) over a line's content, in UTF-16 code units — the units String.slice
// takes, so the renderer cuts tokens with it directly.
export type CharRange = { start: number; end: number }

// Past this share of a line, the changed part IS the line: a rewritten line lights up end to end,
// which is noise rather than emphasis. Measured against the longer side, so a short line replaced
// wholesale bails out while a small edit inside a long line always survives. As a PAIRING rule it
// reads the same way — past this much difference the two lines are not counterparts at all.
export const MAX_CHANGED_FRACTION = 0.75

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

// How alike two lines are, 0..1, or NOT_A_PAIR when they are too different to be counterparts.
const NOT_A_PAIR = -1

function similarityOf(before: string, after: string): number {
  const changed = changedRangesForPair(before, after)
  if (!changed) return 1

  if (changed.changedFraction > MAX_CHANGED_FRACTION) return NOT_A_PAIR

  return 1 - changed.changedFraction
}

export type LinePair = { delIndex: number; addIndex: number }

// Align one del-run against the add-run that follows it, keeping ORDER: a removed line can only
// answer an added line that comes after the one its predecessor answered. Within that constraint
// it maximizes total similarity, which is a two-dimensional choice — hence the table rather than
// a greedy sweep. Runs are a handful of lines in practice, so the n×m table costs nothing.
//
// Lines left unpaired are a real deletion or a real insertion; the callers give them no emphasis
// and no counterpart cell, exactly as an unbalanced run has always rendered.
export function pairChangedLines(dels: readonly string[], adds: readonly string[]): LinePair[] {
  const delCount = dels.length
  const addCount = adds.length

  // best[i][j] = the best total similarity obtainable from dels[i..] and adds[j..].
  const best: number[][] = Array.from({ length: delCount + 1 }, () =>
    new Array<number>(addCount + 1).fill(0)
  )

  for (let delIndex = delCount - 1; delIndex >= 0; delIndex -= 1) {
    for (let addIndex = addCount - 1; addIndex >= 0; addIndex -= 1) {
      const similarity = similarityOf(dels[delIndex]!, adds[addIndex]!)
      const paired =
        similarity === NOT_A_PAIR ? NOT_A_PAIR : similarity + best[delIndex + 1]![addIndex + 1]!

      best[delIndex]![addIndex] = Math.max(
        paired,
        best[delIndex + 1]![addIndex]!,
        best[delIndex]![addIndex + 1]!
      )
    }
  }

  const pairs: LinePair[] = []
  let delIndex = 0
  let addIndex = 0

  while (delIndex < delCount && addIndex < addCount) {
    const similarity = similarityOf(dels[delIndex]!, adds[addIndex]!)
    const paired =
      similarity === NOT_A_PAIR ? NOT_A_PAIR : similarity + best[delIndex + 1]![addIndex + 1]!

    // Pairing wins ties on purpose: with two equally good candidates the nearer one keeps the
    // two runs reading in step, which is what a positional pairing got right in the easy case.
    if (
      paired !== NOT_A_PAIR &&
      paired >= best[delIndex + 1]![addIndex]! &&
      paired >= best[delIndex]![addIndex + 1]!
    ) {
      pairs.push({ delIndex, addIndex })
      delIndex += 1
      addIndex += 1
      continue
    }

    if (best[delIndex + 1]![addIndex]! >= best[delIndex]![addIndex + 1]!) delIndex += 1
    else addIndex += 1
  }

  return pairs
}
