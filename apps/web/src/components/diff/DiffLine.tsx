import type { DraftComment } from "@pr-visulizer/shared"
import { memo } from "react"

import type { LineTokenizer } from "@/utils/highlight/highlighter"

import type { SymbolAnchor } from "@/entity/anchor"
import type { DiffLine as DiffLineVM } from "@/entity/diff"

import { CodeContent } from "./CodeContent"
import styles from "./Diff.module.css"

// Shared empties for the base column, which renders no annotations — a stable reference so the
// memoized row is not re-rendered by a fresh literal.
const NO_ANCHORS: SymbolAnchor[] = []

const ROW_CLASS: Record<DiffLineVM["kind"], string | undefined> = {
  add: styles.lineAdd,
  del: styles.lineDel,
  context: "",
  hunk: styles.lineHunk,
}

// One diff row: side gutters (base | head line numbers) + tokenized content with
// symbol anchors. Added/deleted backgrounds come from tokens (§10).
// memo is required, not an optimization: a 3,000-line diff re-tokenizes every row when the
// pane re-renders for ANY reason (a click on one gutter, a flash, an open composer). The pane
// keeps every prop below referentially stable so only the rows that actually changed re-render.
export const DiffLine = memo(function DiffLine({
  line,
  tokenizer,
  anchors,
  isFlash,
  selected,
  isFindCurrent,
  gutterSide = "head",
  onAnchorClick,
  onShowUsages,
  onSelectLine,
  draftsOnLine,
  onEditDraft,
  onDeleteDraft,
}: {
  line: DiffLineVM
  tokenizer: LineTokenizer | null
  anchors: SymbolAnchor[]
  isFlash: boolean
  selected: boolean
  // Which number the gutter shows. "head" (the default, and the only value the inline view uses)
  // keeps the commentable head-line button; "base" is the side-by-side view's LEFT column, where
  // the base number is shown as plain text — a draft anchors to a head line only (§11), so there
  // is nothing to comment on over there.
  gutterSide?: "head" | "base"
  // The current find-in-file match (feature 3): outlined and tagged so the pane can scroll to it.
  isFindCurrent: boolean
  onAnchorClick: (anchor: SymbolAnchor, withMeta: boolean) => void
  onShowUsages: (anchor: SymbolAnchor) => void
  // A gutter click on a head line (task 5). `extend` is the shift-click flavour, which always
  // stretches from the existing anchor; a plain click runs the click-click range machine.
  onSelectLine: (headLine: number, extend: boolean) => void
  draftsOnLine: DraftComment[]
  onEditDraft: (draft: DraftComment) => void
  onDeleteDraft: (draft: DraftComment) => void
}) {
  const rowClass = [
    styles.line,
    ROW_CLASS[line.kind],
    isFlash ? styles.flash : "",
    selected ? styles.lineSelected : "",
    isFindCurrent ? styles.findCurrent : "",
  ]
    .filter(Boolean)
    .join(" ")

  if (line.kind === "hunk") {
    return (
      <div className={rowClass} data-find-current={isFindCurrent || undefined}>
        <span className={styles.gutter} />
        <span className={styles.content}>{line.content}</span>
      </div>
    )
  }

  // The base (LEFT) column of the side-by-side view shows the "before" text and its base number,
  // nothing else: every annotation on a row — the usages pill, symbol anchors, draft markers, the
  // whitespace-collapse dot — is keyed to the HEAD line (§10, §11), so rendering them on both
  // sides would duplicate each one against the same head line.
  const showAnnotations = gutterSide === "head"
  const shownAnchors = showAnnotations ? anchors : NO_ANCHORS

  // A definition on this line shows an "N usages in this PR" pill (§10).
  const definition = shownAnchors.find(
    (anchor) => anchor.role === "definition" && anchor.hasCounterpart
  )

  // Only head lines (the RIGHT side) are commentable — that is where a draft anchors (§11).
  const headLine = showAnnotations ? line.newLine : null

  return (
    <div className={rowClass} data-find-current={isFindCurrent || undefined}>
      {headLine !== null ? (
        <button
          type="button"
          className={styles.gutterButton}
          aria-label={`Comment on line ${headLine}`}
          title="Comment — click a second line to select a range"
          // A plain click, deliberately: the previous mousedown-and-drag never survived the
          // composer opening under the pointer on the first row, which shifted every later
          // row out from under the drag. Two clicks have nothing to fight.
          onClick={(event) => onSelectLine(headLine, event.shiftKey)}
        >
          {headLine}
        </button>
      ) : (
        <span className={styles.gutter}>{line.oldLine ?? ""}</span>
      )}
      <CodeContent
        text={line.content}
        tokenizer={tokenizer}
        anchors={shownAnchors}
        onAnchorClick={onAnchorClick}
      />
      {line.wsOnly && showAnnotations && (
        <span className={styles.wsOnly} title="whitespace-only change hidden">
          ●
        </span>
      )}
      {definition && (
        <button className={styles.pill} onClick={() => onShowUsages(definition)}>
          {definition.usages.length} usages in this PR
        </button>
      )}
      {showAnnotations &&
        draftsOnLine.map((draft, index) => (
          <span key={index} className={styles.draftMarker}>
            <span className={styles.draftPill} title={draft.body}>
              💬 draft
            </span>
            <button type="button" className={styles.draftAction} onClick={() => onEditDraft(draft)}>
              edit
            </button>
            <button
              type="button"
              className={styles.draftAction}
              onClick={() => onDeleteDraft(draft)}
            >
              delete
            </button>
          </span>
        ))}
    </div>
  )
})
