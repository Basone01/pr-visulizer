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
import { type CharRange, changedRangesForPair } from "./prefixSuffixRange"
import { changedWordRanges, countTokens } from "./wordDiff"

export type { CharRange } from "./prefixSuffixRange"

// Past this share of a line, the changed part IS the line: a rewritten line lights up end to end,
// which is noise rather than emphasis. Measured against the longer side, so a short line replaced
// wholesale bails out while a small edit inside a long line always survives. As a PAIRING rule it
// reads the same way — past this much difference the two lines are not counterparts at all.
export const MAX_CHANGED_FRACTION = 0.75

// The word-by-word measure costs tokens(del) × tokens(add) per candidate pair. Summed over every
// pair in a region that is exactly (all del tokens) × (all add tokens), so one product caps the
// whole region's work. Past it (a big rewrite, or a few very long lines) the region falls back to
// the linear prefix/suffix measure. 250k table cells stay well under a frame's worth of work.
const MAX_WORD_MATCH_CELLS = 250_000

// How alike two lines are, 0..1, or NOT_A_PAIR when they are too different to be counterparts.
const NOT_A_PAIR = -1

type ChangedFractionOf = (before: string, after: string) => number

// Measured on WORDS, the same unit the emphasis paints: `class A {` -> `final class A: B {`
// changes "final " and ": B", about half the line. The prefix/suffix span would count the
// unchanged "class A" too, call it 90% changed, and refuse to pair two lines that clearly are.
// Only non-space characters count: spaces match between almost any two lines, so counting them
// would make a full rewrite look a quarter similar.
function visibleLength(text: string): number {
  return text.replace(/\s/g, "").length
}

function wordChangedFraction(before: string, after: string): number {
  const changed = changedWordRanges(before, after)
  if (!changed) return 0

  const changedLength = (line: string, ranges: CharRange[]): number =>
    ranges.reduce((sum, range) => sum + visibleLength(line.slice(range.start, range.end)), 0)
  const longestChange = Math.max(
    changedLength(before, changed.before),
    changedLength(after, changed.after)
  )
  const longestLine = Math.max(visibleLength(before), visibleLength(after))
  if (longestLine === 0) return 0

  return longestChange / longestLine
}

function spanChangedFraction(before: string, after: string): number {
  return changedRangesForPair(before, after)?.changedFraction ?? 0
}

function similarityOf(before: string, after: string, changedFractionOf: ChangedFractionOf): number {
  const changedFraction = changedFractionOf(before, after)
  if (changedFraction > MAX_CHANGED_FRACTION) return NOT_A_PAIR

  return 1 - changedFraction
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

  const sumTokens = (lines: readonly string[]): number =>
    lines.reduce((sum, line) => sum + countTokens(line), 0)
  const isAffordable = sumTokens(dels) * sumTokens(adds) <= MAX_WORD_MATCH_CELLS
  const changedFractionOf = isAffordable ? wordChangedFraction : spanChangedFraction

  // Each pair is measured once here and read again by the walk below, so the walk adds no work.
  const similarity: number[][] = dels.map((del) =>
    adds.map((add) => similarityOf(del, add, changedFractionOf))
  )

  // best[i][j] = the best total similarity obtainable from dels[i..] and adds[j..].
  const best: number[][] = Array.from({ length: delCount + 1 }, () =>
    new Array<number>(addCount + 1).fill(0)
  )

  for (let delIndex = delCount - 1; delIndex >= 0; delIndex -= 1) {
    for (let addIndex = addCount - 1; addIndex >= 0; addIndex -= 1) {
      const pairSimilarity = similarity[delIndex]![addIndex]!
      const paired =
        pairSimilarity === NOT_A_PAIR
          ? NOT_A_PAIR
          : pairSimilarity + best[delIndex + 1]![addIndex + 1]!

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
    const pairSimilarity = similarity[delIndex]![addIndex]!
    const paired =
      pairSimilarity === NOT_A_PAIR
        ? NOT_A_PAIR
        : pairSimilarity + best[delIndex + 1]![addIndex + 1]!

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
