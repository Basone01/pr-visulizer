import { type CharRange, changedRangesForPair } from "./prefixSuffixRange"

// Word-level emphasis inside one paired line (§10). The prefix/suffix cut in pairChangedLines
// marks ONE span from the first difference to the last, so `class A {` -> `final class A: B {`
// lit up everything from "final" to ": B", the unchanged "class A" included. Matching WORDS
// (a longest common subsequence over tokens) marks only what changed: "final " and ": B".

// A word (letters, digits, underscore), a run of whitespace, or ONE other character. Punctuation
// is split per character so `a,b` -> `a, b` marks the ", " and not the whole `a,b` token.
// The `u` flag keeps an astral character (an emoji in a string) as one token.
const TOKEN_PATTERN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

// Past this many tokens on either side, the n×m table gets expensive (a minified line has
// thousands), so the line falls back to the single prefix/suffix span.
const MAX_TOKENS = 500

type Token = { text: string; start: number; end: number }

export type WordRanges = { before: CharRange[]; after: CharRange[] }

function tokenize(line: string): Token[] {
  return [...line.matchAll(TOKEN_PATTERN)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

// Which tokens of each side are part of the longest common subsequence.
// Backtracking from the END on purpose: an equal last token is always part of some LCS, so
// matching greedily from the end binds a trailing ` {` to the trailing ` {` on the other side.
// That keeps a change like ": Sendable" in one piece instead of splitting it around a space.
function matchTokens(before: Token[], after: Token[]): { before: boolean[]; after: boolean[] } {
  const beforeCount = before.length
  const afterCount = after.length

  // lcs[i][j] = LCS length of before[0..i) and after[0..j).
  const lcs: number[][] = Array.from({ length: beforeCount + 1 }, () =>
    new Array<number>(afterCount + 1).fill(0)
  )
  for (let i = 1; i <= beforeCount; i += 1) {
    for (let j = 1; j <= afterCount; j += 1) {
      lcs[i]![j] =
        before[i - 1]!.text === after[j - 1]!.text
          ? lcs[i - 1]![j - 1]! + 1
          : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!)
    }
  }

  const beforeMatched = new Array<boolean>(beforeCount).fill(false)
  const afterMatched = new Array<boolean>(afterCount).fill(false)

  let i = beforeCount
  let j = afterCount
  while (i > 0 && j > 0) {
    if (before[i - 1]!.text === after[j - 1]!.text) {
      beforeMatched[i - 1] = true
      afterMatched[j - 1] = true
      i -= 1
      j -= 1
      continue
    }

    if (lcs[i - 1]![j]! >= lcs[i]![j - 1]!) i -= 1
    else j -= 1
  }

  return { before: beforeMatched, after: afterMatched }
}

// Two matches can be equally long: in `"b"]` -> `"b", "threads"]` the closing quote of "b" can
// pair with either closing quote, and the end-first backtrack picks the later one, which marks
// `", "threads` instead of `, "threads"`. Same fix git uses: slide each changed run right while
// its first token equals the matched token just after it. The match stays a valid LCS.
function slideRunsRight(tokens: Token[], matched: boolean[]): boolean[] {
  const slid = [...matched]

  let start = 0
  while (start < tokens.length) {
    if (slid[start]) {
      start += 1
      continue
    }

    let end = start
    while (end < tokens.length && !slid[end]) end += 1

    while (end < tokens.length && slid[end] && tokens[start]!.text === tokens[end]!.text) {
      slid[start] = true
      slid[end] = false
      start += 1
      end += 1
    }

    start = end
  }

  return slid
}

// Unmatched tokens that touch each other become one range, so "final " is one box, not two.
function unmatchedRanges(tokens: Token[], matched: boolean[]): CharRange[] {
  const ranges: CharRange[] = []

  tokens.forEach((token, index) => {
    if (matched[index]) return

    const last = ranges.at(-1)
    if (last && last.end === token.start) last.end = token.end
    else ranges.push({ start: token.start, end: token.end })
  })

  return ranges
}

// The changed ranges on each side of a pair. null when the lines are identical.
export function changedWordRanges(before: string, after: string): WordRanges | null {
  if (before === after) return null

  const beforeTokens = tokenize(before)
  const afterTokens = tokenize(after)

  const isTooLong = beforeTokens.length > MAX_TOKENS || afterTokens.length > MAX_TOKENS
  if (isTooLong) {
    const span = changedRangesForPair(before, after)
    if (!span) return null

    return { before: [span.before], after: [span.after] }
  }

  const matched = matchTokens(beforeTokens, afterTokens)
  const beforeMatched = slideRunsRight(beforeTokens, matched.before)
  const afterMatched = slideRunsRight(afterTokens, matched.after)

  return {
    before: unmatchedRanges(beforeTokens, beforeMatched),
    after: unmatchedRanges(afterTokens, afterMatched),
  }
}
