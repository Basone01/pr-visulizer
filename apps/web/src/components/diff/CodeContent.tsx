import { useMemo } from "react"

import type { LineTokenizer } from "@/utils/highlight/highlighter"

import type { SymbolAnchor } from "@/entity/anchor"

import styles from "./Diff.module.css"

// Renders one code line: shiki tokens for syntax color (foreground), with any symbol
// anchor on the line turned into a dotted-underline interactive span (§10). The diff
// status background lives on the row, not here — the layers never fight.
export function CodeContent({
  text,
  tokenizer,
  anchors,
  onAnchorClick,
}: {
  text: string
  tokenizer: LineTokenizer | null
  anchors: SymbolAnchor[]
  onAnchorClick: (anchor: SymbolAnchor, withMeta: boolean) => void
}) {
  // Tokenizing is a grammar run per line; a re-render for any other reason (selection, flash,
  // a draft pill) must not pay for it again.
  const tokens = useMemo(() => (tokenizer ? tokenizer(text) : null), [tokenizer, text])

  // Until shiki loads, show plain text — highlighting never blocks the diff.
  if (!tokens) return <span className={styles.content}>{text}</span>

  return (
    <span className={styles.content}>
      {tokens.map((token, index) => {
        // Underline only when the token IS a navigable symbol with a counterpart.
        const anchor = anchors.find(
          (candidate) => candidate.hasCounterpart && candidate.name === token.content
        )

        if (!anchor) {
          return (
            <span key={index} style={{ color: token.cssVar }}>
              {token.content}
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
            {token.content}
          </span>
        )
      })}
    </span>
  )
}
