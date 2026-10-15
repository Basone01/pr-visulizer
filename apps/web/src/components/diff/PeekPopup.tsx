import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { DEFAULT_SETTINGS } from "@/config/settings"

import { buildFullFileView } from "@/utils/diff/fullFileView"
import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"

import type { OccurrenceRef } from "@/entity/anchor"
import type { ParsedDiff } from "@/entity/diff"
import type { PrTarget } from "@/entity/pr"

import { fileAtHeadQueryOptions, patchQueryOptions } from "@/service/queries"

import { useLineTokenizer } from "@/hooks/useLineTokenizer"

import { CodeContent } from "./CodeContent"
import styles from "./Diff.module.css"

// A definition can sit entirely outside every hunk, so the head text alone must be able to
// carry the peek — `buildFullFileView` then emits the whole file as context.
const NO_PATCH: ParsedDiff = { lines: [] }

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
  onClose,
}: {
  target: PrTarget
  definition: OccurrenceRef
  span: { startLine: number; endLine: number }
  truncated: boolean
  expanded: boolean
  onExpand: () => void
  onJump: () => void
  // Dismiss without navigating. The open state lives in the nav machine (§10), so closing is
  // the host's action — this component owns no visibility state of its own.
  onClose: () => void
}) {
  const patchQuery = useQuery(patchQueryOptions(target, definition.path))
  // The head revision is the only source that holds EVERY line of the definition. Same query
  // key the full-file view and the ghost pane use, so a file already read for either is free.
  const headQuery = useQuery(fileAtHeadQueryOptions(target, definition.path, true))
  // The definition can live in another file than the open one — and the engine now analyses Go,
  // PHP and Python too, so the grammar follows the DEFINITION's path, not the diff's.
  const tokenizer = useLineTokenizer(definition.path)

  // null = the client has no head content for this file (or the read failed).
  const headText = headQuery.data ?? null

  // The definition's own lines, by head line number. The patch alone can't answer this: it
  // carries hunk lines only, so every line of the definition outside a changed region is
  // simply absent — a definition wider than its hunks used to render starting mid-body while
  // the footer still claimed the whole thing. `buildFullFileView` is the merge that fixes it
  // (patch authoritative inside hunks, head text filling the gaps, head numbering preserved),
  // the same transform the full-file toggle renders with.
  const definitionLines = useMemo(() => {
    const parsed = patchQuery.data ? parseUnifiedDiff(patchQuery.data) : null
    const view = headText === null ? parsed : buildFullFileView(headText, parsed ?? NO_PATCH)
    if (!view) return []

    return view.lines.filter(
      (line) =>
        line.newLine !== null && line.newLine >= span.startLine && line.newLine <= span.endLine
    )
  }, [patchQuery.data, headText, span.startLine, span.endLine])

  const totalLines = span.endLine - span.startLine + 1
  const previewLines = DEFAULT_SETTINGS.peekPreviewLines
  // Truncation is decided from the SPAN by the nav machine, but a degraded source can leave
  // fewer lines than the preview shows — never offer to reveal lines that aren't there.
  const showTruncated = truncated && !expanded && definitionLines.length > previewLines
  const visibleLines = showTruncated ? definitionLines.slice(0, previewLines) : definitionLines
  const hiddenCount = definitionLines.length - previewLines
  const loading = patchQuery.isPending || headQuery.isPending
  // Only claim the WHOLE definition when every line of the span is actually on screen.
  const complete = definitionLines.length >= totalLines

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
        <button
          type="button"
          className={`${styles.peekAction} ${styles.peekClose}`}
          aria-label="Close peek"
          title="Close peek (Esc)"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {/* The body is the one region a test has to read whole — the rows are split into
          per-token spans, so there is no single text node to query. */}
      <div className={bodyClass} data-peek-body>
        {loading && visibleLines.length === 0 && (
          <div className={styles.peekEmpty}>Loading definition…</div>
        )}
        {!loading && visibleLines.length === 0 && (
          <div className={styles.peekEmpty}>This definition's source isn't available here.</div>
        )}
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
        ) : complete ? (
          <span>whole definition ({totalLines} lines)</span>
        ) : (
          // Saying "whole definition" over a partial body is the bug this slice fixes; when the
          // source is degraded the footer says what is actually on screen instead.
          <span>
            {definitionLines.length} of {totalLines} lines
          </span>
        )}
        <button className={styles.peekAction} onClick={onJump}>
          Jump ⏎
        </button>
        <span>⌘-click jumps directly</span>
      </div>
    </div>
  )
}
