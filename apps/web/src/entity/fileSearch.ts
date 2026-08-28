// Fuzzy file search behind the ⌘P palette — VS Code's quick open, minus the dependency.
// Subsequence matching: the query's characters must appear in order, not next to each other,
// so "atk" finds `src/auth/token.ts`. Pure and React-free, so every scoring rule is unit-testable.

export type FileMatch = {
  path: string
  score: number
  // Indices INTO `path` of the characters the query matched — the palette marks exactly these.
  matchedIndices: number[]
}

// A long PR can change hundreds of files; the palette renders the top slice, never all of them.
export const MAX_FILE_RESULTS = 50

// Scoring weights. Deliberately coarse — the ordering they produce has to be explainable to the
// reviewer ("it matched the file name") rather than tuned to a benchmark.
const BASENAME_BONUS = 40 // the whole query fit inside the file name, not the folders
const SEGMENT_START_BONUS = 12 // the character starts a path segment ("src/AUTH/token.ts")
const WORD_START_BONUS = 8 // it starts a word inside a segment (after . - _ or a camel hump)
const CONSECUTIVE_BONUS = 6 // it sits right after the previous match — a run beats scattered hits
const MATCHED_CHAR_SCORE = 4 // every matched character is worth something on its own

// A recently viewed file outranks every non-recent match, so the boost is larger than any score
// a match can reach — recency first, match quality within it.
const RECENT_BOOST = 1000

// Index where the file name starts (0 when the path has no folders). The palette splits its rows
// on the same boundary the scoring favors, so the highlight and the score can never disagree.
export function baseNameStart(path: string): number {
  return path.lastIndexOf("/") + 1
}

// Greedy left-to-right subsequence match, case-insensitive. Null when a query character has no
// place left to land — that file simply isn't a match.
function matchSubsequence(text: string, query: string): number[] | null {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()

  const indices: number[] = []
  let cursor = 0

  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return null

    indices.push(found)
    cursor = found + 1
  }

  return indices
}

function isSegmentStart(path: string, index: number): boolean {
  return index === 0 || path[index - 1] === "/"
}

function isWordStart(path: string, index: number): boolean {
  const previous = path[index - 1] ?? ""
  const current = path[index] ?? ""

  const afterSeparator = previous === "." || previous === "-" || previous === "_"
  const camelHump = previous === previous.toLowerCase() && current !== current.toLowerCase()

  return afterSeparator || camelHump
}

function scoreMatch(path: string, indices: number[]): number {
  let score = 0
  let previousIndex = -1

  for (const index of indices) {
    score += MATCHED_CHAR_SCORE

    if (isSegmentStart(path, index)) score += SEGMENT_START_BONUS
    else if (isWordStart(path, index)) score += WORD_START_BONUS

    if (index === previousIndex + 1) score += CONSECUTIVE_BONUS

    previousIndex = index
  }

  return score
}

// Score one path against the query, or null when it doesn't match at all.
export function matchFilePath(path: string, query: string): FileMatch | null {
  // Spaces are how people separate the parts they remember ("auth tok"), never something a path
  // contains here — drop them rather than fail the match on them.
  const needle = query.replace(/\s+/g, "")
  if (needle === "") return { path, score: 0, matchedIndices: [] }

  const nameStart = baseNameStart(path)

  // File name first: "token" should find `src/auth/token.ts` on its NAME, not on letters scattered
  // through the folders. Only when the name can't hold the whole query do we fall back to the full
  // path — which is how "auth/tok" still matches.
  const nameIndices = matchSubsequence(path.slice(nameStart), needle)
  if (nameIndices) {
    const indices = nameIndices.map((index) => index + nameStart)

    return { path, score: BASENAME_BONUS + scoreMatch(path, indices), matchedIndices: indices }
  }

  const pathIndices = matchSubsequence(path, needle)
  if (!pathIndices) return null

  return { path, score: scoreMatch(path, pathIndices), matchedIndices: pathIndices }
}

// The palette's whole list, in the order it renders: recent matches first, then the rest by score.
export function rankFileMatches({
  filePaths,
  recentFiles,
  query,
  limit = MAX_FILE_RESULTS,
}: {
  filePaths: readonly string[]
  recentFiles: readonly string[]
  query: string
  limit?: number
}): FileMatch[] {
  // An empty query is the switcher, not a search: the recent list exactly as it was viewed.
  if (query.trim() === "") {
    return recentFiles.slice(0, limit).map((path) => ({ path, score: 0, matchedIndices: [] }))
  }

  const recentPaths = new Set(recentFiles)

  const matches: FileMatch[] = []
  for (const path of filePaths) {
    const match = matchFilePath(path, query)
    if (!match) continue

    matches.push(recentPaths.has(path) ? { ...match, score: match.score + RECENT_BOOST } : match)
  }

  // Path order breaks ties so the same query always renders the same list.
  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))

  return matches.slice(0, limit)
}
