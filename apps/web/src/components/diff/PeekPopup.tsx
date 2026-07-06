import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { DEFAULT_SETTINGS } from "@/config/settings"

import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"

import type { OccurrenceRef } from "@/entity/anchor"
import type { PrTarget } from "@/entity/pr"

import { patchQueryOptions } from "@/service/queries"

import { useLineTokenizer } from "@/hooks/useLineTokenizer"

import { CodeContent } from "./CodeContent"
import styles from "./Diff.module.css"

// The peek popover (§10): the definition rendered inline, same status + syntax layers
// as the main diff. Long definitions truncate with a fade and expand in place; the
// reviewer's scroll position in the main diff never moves.
export function PeekPopup({
  target,
  definition,
  span,
  truncated,
  expanded,
  onExpand,
  onJump,
}: {
  target: PrTarget
  definition: OccurrenceRef
  span: { startLine: number; endLine: number }
  truncated: boolean
  expanded: boolean
  onExpand: () => void
  onJump: () => void
}) {
  const patchQuery = useQuery(patchQueryOptions(target, definition.path))
  const tokenizer = useLineTokenizer("typescript")

  // Slice the definition's own lines out of its file patch by head line number.
  const definitionLines = useMemo(() => {
    if (!patchQuery.data) return []

    const parsed = parseUnifiedDiff(patchQuery.data)
    return parsed.lines.filter(
      (line) =>
        line.newLine !== null && line.newLine >= span.startLine && line.newLine <= span.endLine
    )
  }, [patchQuery.data, span.startLine, span.endLine])

  const totalLines = span.endLine - span.startLine + 1
  const showTruncated = truncated && !expanded
  const previewLines = DEFAULT_SETTINGS.peekPreviewLines
  const visibleLines = showTruncated ? definitionLines.slice(0, previewLines) : definitionLines
  const hiddenCount = totalLines - previewLines

  const bodyClass = [
    styles.peekBody,
    showTruncated ? styles.peekTruncated : "",
    expanded ? styles.peekScroll : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={styles.peek}>
      <div className={styles.peekHead}>
        <span className="mono">
          {definition.path}:{span.startLine}
        </span>
        <span className={styles.peekTag}>in this PR</span>
      </div>

      <div className={bodyClass}>
        {visibleLines.map((line, index) => (
          <div
            key={index}
            className={`${styles.line} ${line.kind === "add" ? styles.lineAdd : ""}`}
          >
            <span className={styles.gutter}>{line.newLine}</span>
            <CodeContent
              text={line.content}
              tokenizer={tokenizer}
              anchors={[]}
              onAnchorClick={() => {}}
            />
          </div>
        ))}
      </div>

      <div className={styles.peekFoot}>
        {showTruncated ? (
          <button className={styles.peekAction} onClick={onExpand}>
            Show {hiddenCount} more ↓
          </button>
        ) : (
          <span>whole definition ({totalLines} lines)</span>
        )}
        <button className={styles.peekAction} onClick={onJump}>
          Jump ⏎
        </button>
        <span>⌘-click jumps directly</span>
      </div>
    </div>
  )
}
