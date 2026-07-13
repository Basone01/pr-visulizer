import type { DraftComment } from "@pr-visulizer/shared"
import { memo } from "react"

import type { LineTokenizer } from "@/utils/highlight/highlighter"

import type { SymbolAnchor } from "@/entity/anchor"
import type { DiffLine as DiffLineVM } from "@/entity/diff"

import { CodeContent } from "./CodeContent"
import styles from "./Diff.module.css"

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
  // The current find-in-file match (feature 3): outlined and tagged so the pane can scroll to it.
  isFindCurrent: boolean
  onAnchorClick: (anchor: SymbolAnchor, withMeta: boolean) => void
  onShowUsages: (anchor: SymbolAnchor) => void
  // Begin (plain click) or extend (shift-click) a comment selection on a head line (task 5).
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

  // A definition on this line shows an "N usages in this PR" pill (§10).
  const definition = anchors.find((anchor) => anchor.role === "definition" && anchor.hasCounterpart)

  // Only head lines (the RIGHT side) are commentable — that is where a draft anchors (§11).
  const headLine = line.newLine

  return (
    <div className={rowClass} data-find-current={isFindCurrent || undefined}>
      {headLine !== null ? (
        <button
          type="button"
          className={styles.gutterButton}
          aria-label={`Comment on line ${headLine}`}
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
        anchors={anchors}
        onAnchorClick={onAnchorClick}
      />
      {line.wsOnly && (
        <span className={styles.wsOnly} title="whitespace-only change hidden">
          ●
        </span>
      )}
      {definition && (
        <button className={styles.pill} onClick={() => onShowUsages(definition)}>
          {definition.usages.length} usages in this PR
        </button>
      )}
      {draftsOnLine.map((draft, index) => (
        <span key={index} className={styles.draftMarker}>
          <span className={styles.draftPill} title={draft.body}>
            💬 draft
          </span>
          <button type="button" className={styles.draftAction} onClick={() => onEditDraft(draft)}>
            edit
          </button>
          <button type="button" className={styles.draftAction} onClick={() => onDeleteDraft(draft)}>
            delete
          </button>
        </span>
      ))}
    </div>
  )
})
