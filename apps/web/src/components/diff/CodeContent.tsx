import { type ReactNode, useMemo } from "react"

import { type CharRange, splitByRanges } from "@/utils/diff/intraLineDiff"
import type { LineTokenizer, SyntaxToken } from "@/utils/highlight/highlighter"

import type { SymbolAnchor } from "@/entity/anchor"

import styles from "./Diff.module.css"

// Shared empty, so a line with no intra-line emphasis keeps the same prop reference across
// renders and the memoized row skips re-rendering (same trick as DiffLine's NO_ANCHORS).
export const NO_CHAR_RANGES: CharRange[] = []

// Where each token starts in the line — a token carries its text but not its position, and the
// intra-line ranges are line-relative.
type PositionedToken = { token: SyntaxToken; start: number }

function positionTokens(tokens: SyntaxToken[]): PositionedToken[] {
  let start = 0

  return tokens.map((token) => {
    const positioned = { token, start }
    start += token.content.length

    return positioned
  })
}

// Renders one code line: shiki tokens for syntax color (foreground), with any symbol
// anchor on the line turned into a dotted-underline interactive span (§10). The diff
// status background lives on the row, not here — the layers never fight.
export function CodeContent({
  text,
  tokenizer,
  anchors,
  onAnchorClick,
  charRanges = NO_CHAR_RANGES,
  charClass,
}: {
  text: string
  tokenizer: LineTokenizer | null
  anchors: SymbolAnchor[]
  onAnchorClick: (anchor: SymbolAnchor, withMeta: boolean) => void
  // Characters that differ from this line's counterpart in the pair (§10), when the intra-line
  // toggle is on. Empty is the whole feature off — every branch below then renders plain text.
  charRanges?: CharRange[]
  // Which side's emphasis to paint (add or del); undefined on a line that has none.
  charClass?: string | undefined
}) {
  // Tokenizing is a grammar run per line; a re-render for any other reason (selection, flash,
  // a draft pill) must not pay for it again.
  const tokens = useMemo(() => (tokenizer ? tokenizer(text) : null), [tokenizer, text])

  // Emphasis is painted INSIDE the token (and inside an anchor), never around it: the segment
  // spans carry only a background, so the token's syntax color and the anchor's underline and
  // click target both survive being split. That is also why a range crossing token boundaries
  // arrives here as several spans — `data-run` tells the CSS which of them are joined, so the
  // pieces drop their touching edges and read as ONE box (Diff.module.css `.charRun`).
  function emphasize(pieceText: string, pieceStart: number): ReactNode {
    if (charRanges.length === 0) return pieceText

    return splitByRanges(pieceText, pieceStart, charRanges).map((segment, index) =>
      segment.changed ? (
        <span key={index} className={`${styles.charRun} ${charClass ?? ""}`} data-run={segment.run}>
          {segment.text}
        </span>
      ) : (
        segment.text
      )
    )
  }

  // Until shiki loads, show plain text — highlighting never blocks the diff.
  if (!tokens) return <span className={styles.content}>{emphasize(text, 0)}</span>

  return (
    <span className={styles.content}>
      {positionTokens(tokens).map(({ token, start }, index) => {
        // Underline only when the token IS a navigable symbol with a counterpart.
        const anchor = anchors.find(
          (candidate) => candidate.hasCounterpart && candidate.name === token.content
        )

        if (!anchor) {
          return (
            <span key={index} style={{ color: token.cssVar }}>
              {emphasize(token.content, start)}
            </span>
          )
        }

        return (
          <span
            key={index}
            className={styles.anchor}
            style={{ color: token.cssVar }}
            onClick={(event) => onAnchorClick(anchor, event.metaKey || event.ctrlKey)}
            role="button"
            tabIndex={0}
          >
            {emphasize(token.content, start)}
          </span>
        )
      })}
    </span>
  )
}
