// How much of one diff line the pane lays out, and how much of it is highlighted. A minified
// bundle or a source map is one line of 50 KB or more. The highlighter's cost grows faster
// than the line (measured in V8 on a source-map line: 200 chars 2.3 ms, 500 chars 11 ms,
// 1,000 chars 41 ms, 2,000 chars 157 ms), and WebKit is about 3x slower, so a long line is
// shown as plain text and only its start is laid out.
export const MAX_SHOWN_LINE_CHARS = 2_000
export const MAX_HIGHLIGHTED_LINE_CHARS = 500

export type ShownLine = {
  text: string
  // How many UTF-16 code units of the line are not shown. 0 for a line that fits.
  hiddenChars: number
  // Whether the line is short enough to highlight.
  highlight: boolean
}

export function shownPartOfLine(text: string, maxChars: number = MAX_SHOWN_LINE_CHARS): ShownLine {
  const highlight = text.length <= MAX_HIGHLIGHTED_LINE_CHARS
  if (text.length <= maxChars) return { text, hiddenChars: 0, highlight }

  // Never cut between the two halves of a surrogate pair (an emoji, for example).
  const lastShown = text.charCodeAt(maxChars - 1)
  const isHighSurrogate = lastShown >= 0xd800 && lastShown <= 0xdbff
  const cut = isHighSurrogate ? maxChars - 1 : maxChars
  return { text: text.slice(0, cut), hiddenChars: text.length - cut, highlight }
}
