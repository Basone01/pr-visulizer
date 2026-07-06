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
export function DiffLine({
  line,
  tokenizer,
  anchors,
  isFlash,
  onAnchorClick,
  onShowUsages,
}: {
  line: DiffLineVM
  tokenizer: LineTokenizer | null
  anchors: SymbolAnchor[]
  isFlash: boolean
  onAnchorClick: (anchor: SymbolAnchor, withMeta: boolean) => void
  onShowUsages: (anchor: SymbolAnchor) => void
}) {
  const rowClass = [styles.line, ROW_CLASS[line.kind], isFlash ? styles.flash : ""]
    .filter(Boolean)
    .join(" ")

  if (line.kind === "hunk") {
    return (
      <div className={rowClass}>
        <span className={styles.gutter} />
        <span className={styles.content}>{line.content}</span>
      </div>
    )
  }

  // A definition on this line shows an "N usages in this PR" pill (§10).
  const definition = anchors.find((anchor) => anchor.role === "definition" && anchor.hasCounterpart)

  return (
    <div className={rowClass}>
      <span className={styles.gutter}>{line.newLine ?? line.oldLine ?? ""}</span>
      <CodeContent
        text={line.content}
        tokenizer={tokenizer}
        anchors={anchors}
        onAnchorClick={onAnchorClick}
      />
      {definition && (
        <button className={styles.pill} onClick={() => onShowUsages(definition)}>
          {definition.usages.length} usages in this PR
        </button>
      )}
    </div>
  )
}
