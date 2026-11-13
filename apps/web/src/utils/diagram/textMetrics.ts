// Text sizing without a DOM: a width estimate per character, so layout can run anywhere
// (worker, test, server). The budgets come from the diagram style guide the chat diagrams follow:
// 0.60 em per character for the sans stack, 0.62 em for mono, a full em for wide (CJK) characters.

export type FontFamily = "sans" | "mono"

const EM_PER_CHAR: Record<FontFamily, number> = { sans: 0.6, mono: 0.62 }

// East Asian wide and fullwidth ranges, plus emoji, take a full em.
const WIDE_CHARACTER = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u

// `letterSpacingEm` is the CSS letter-spacing the text is drawn with, added after every character.
export function estimateTextWidth(
  text: string,
  fontSize: number,
  family: FontFamily,
  letterSpacingEm = 0
): number {
  let ems = 0
  for (const character of text) ems += characterEms(character, family, letterSpacingEm)

  return ems * fontSize
}

function characterEms(character: string, family: FontFamily, letterSpacingEm: number): number {
  return (WIDE_CHARACTER.test(character) ? 1 : EM_PER_CHAR[family]) + letterSpacingEm
}

export type WrappedText = {
  lines: string[]
  // True when text was cut with "…" to fit maxLines; the caller then shows the full text elsewhere.
  truncated: boolean
}

// Greedy word wrap into at most maxLines lines of maxWidth. A word longer than a line is broken
// by character. The last line is cut with "…" when text remains.
// Linear in the text: widths are summed once per character, and wrapping stops as soon as there
// is one line more than it keeps (that line only says "there is more").
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  family: FontFamily,
  maxLines: number,
  letterSpacingEm = 0
): WrappedText {
  const measure = { maxWidth, fontSize, family, letterSpacingEm }
  const lines: string[] = []

  for (const line of wrappedLines(text, measure)) {
    lines.push(line)
    if (lines.length > maxLines) break
  }
  if (lines.length <= maxLines) return { lines, truncated: false }

  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = withEllipsis(kept[maxLines - 1] ?? "", measure)
  return { lines: kept, truncated: true }
}

type Measure = { maxWidth: number; fontSize: number; family: FontFamily; letterSpacingEm: number }

function* wrappedLines(text: string, measure: Measure): Generator<string> {
  const width = (text: string) =>
    estimateTextWidth(text, measure.fontSize, measure.family, measure.letterSpacingEm)
  const spaceWidth = width(" ")
  let current = ""
  let currentWidth = 0

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const wordWidth = width(word)
    const joinedWidth = current ? currentWidth + spaceWidth + wordWidth : wordWidth
    if (joinedWidth <= measure.maxWidth) {
      current = current ? `${current} ${word}` : word
      currentWidth = joinedWidth
      continue
    }

    if (current) yield current

    let rest = word
    let restWidth = wordWidth
    while (restWidth > measure.maxWidth) {
      const head = fittingPrefix(rest, measure)
      yield head.text
      rest = rest.slice(head.text.length)
      restWidth -= head.width
    }
    current = rest
    currentWidth = restWidth
  }

  if (current) yield current
}

// The longest start of `word` that fits a line, at least one character, from a running sum.
function fittingPrefix(word: string, measure: Measure): { text: string; width: number } {
  let length = 0
  let width = 0

  for (const character of word) {
    const characterWidth =
      characterEms(character, measure.family, measure.letterSpacingEm) * measure.fontSize
    if (length > 0 && width + characterWidth > measure.maxWidth) break

    length += character.length
    width += characterWidth
  }

  return { text: word.slice(0, length), width }
}

function withEllipsis(line: string, measure: Measure): string {
  const width = (text: string) =>
    estimateTextWidth(text, measure.fontSize, measure.family, measure.letterSpacingEm)
  const ellipsisWidth = width("…")
  const characters = Array.from(line)
  let lineWidth = width(line)

  while (characters.length > 0 && lineWidth + ellipsisWidth > measure.maxWidth) {
    const removed = characters.pop() ?? ""
    lineWidth -= characterEms(removed, measure.family, measure.letterSpacingEm) * measure.fontSize
  }

  return `${characters.join("").trimEnd()}…`
}

// Every coordinate and size in a diagram sits on a 4 px grid.
export function snapUp(value: number, grid = 4): number {
  return Math.ceil(value / grid) * grid
}
