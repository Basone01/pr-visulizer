import type { ChangedFile, ChangedSymbol } from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import { Fragment, useEffect, useMemo, useState } from "react"

import { anchorsForLine } from "@/utils/diff/anchors"
import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"

import type { AnchorIndex, SymbolAnchor } from "@/entity/anchor"
import type { PrTarget } from "@/entity/pr"

import { patchQueryOptions } from "@/service/queries"

import { useLineTokenizer } from "@/hooks/useLineTokenizer"
import type { PeekNavApi } from "@/hooks/usePeekNavigation"

import styles from "./Diff.module.css"
import { DiffLine } from "./DiffLine"
import { PeekPopup } from "./PeekPopup"
import { UsagesPopover } from "./UsagesPopover"

const STATUS_TAG: Record<ChangedFile["status"], string | undefined> = {
  added: styles.tagAdded,
  modified: styles.tagModified,
  deleted: styles.tagDeleted,
  renamed: styles.tagModified,
}

type DiffPaneProps = {
  target: PrTarget
  file: ChangedFile | null
  symbols: ChangedSymbol[]
  anchorIndex: AnchorIndex
  nav: PeekNavApi
  reviewed: boolean
  onToggleReviewed: (path: string) => void
}

// The diff pane (docs/architecture.md §10): parsed unified diff + syntax highlight +
// the symbol-anchor overlay, peek popup, usages popover, jump stack and back chip.
export function DiffPane({
  target,
  file,
  symbols,
  anchorIndex,
  nav,
  reviewed,
  onToggleReviewed,
}: DiffPaneProps) {
  const path = file?.path ?? ""
  const patchQuery = useQuery(patchQueryOptions(target, path))
  const tokenizer = useLineTokenizer(file?.language ?? null)
  const [usagesAnchor, setUsagesAnchor] = useState<SymbolAnchor | null>(null)

  const parsed = useMemo(
    () => (patchQuery.data ? parseUnifiedDiff(patchQuery.data) : null),
    [patchQuery.data]
  )

  const spanById = useMemo(
    () => new Map(symbols.map((symbol) => [symbol.id, symbol.span])),
    [symbols]
  )

  // A jump elsewhere closes any open usages list in this file.
  const currentPath = nav.state.current.path
  useEffect(() => setUsagesAnchor(null), [currentPath])

  // Clear the flash highlight after the animation so a later jump can re-trigger it.
  const { flash } = nav.state
  const { clearFlash } = nav
  useEffect(() => {
    if (!flash) return

    const timer = setTimeout(clearFlash, 1200)
    return () => clearTimeout(timer)
  }, [flash, clearFlash])

  if (!file) {
    return (
      <div className={styles.pane}>
        <div className={styles.empty}>Select a file from the graph or the review queue.</div>
      </div>
    )
  }

  function handleAnchorClick(anchor: SymbolAnchor, withMeta: boolean): void {
    // ⌘/Ctrl-click bypasses the peek and jumps directly (§10).
    if (withMeta) {
      nav.jumpToDefinition(anchor)
      return
    }

    if (anchor.role === "definition") {
      setUsagesAnchor(anchor)
      return
    }

    const span = spanById.get(anchor.symbolId)
    const lineCount = span ? span.endLine - span.startLine + 1 : 1
    nav.peekUsage(anchor, lineCount)
  }

  const peek = nav.state.peek
  const peekSpan = peek ? spanById.get(peek.anchor.symbolId) : undefined

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <span className={`${styles.path} mono`}>{file.path}</span>
          <span className={`${styles.tag} ${STATUS_TAG[file.status]}`}>{file.status}</span>
          <span className={`${styles.churn} mono`}>
            +{file.additions} −{file.deletions}
          </span>
          <span className={styles.spacer} />
          <label className={styles.viewed}>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={() => onToggleReviewed(file.path)}
            />
            Mark viewed
          </label>
        </div>

        {nav.state.jumpStack.length > 0 && (
          <button className={styles.back} onClick={nav.back}>
            ↩ back
          </button>
        )}
      </div>

      <div className={styles.diff}>
        {!parsed && <div className={styles.empty}>Loading diff…</div>}

        {parsed?.lines.map((line, index) => {
          const headLine = line.newLine
          const anchors = headLine !== null ? anchorsForLine(anchorIndex, file.path, headLine) : []
          const isFlash = flash !== null && flash.path === file.path && flash.line === headLine

          const showPeek = peek !== null && peekSpan !== undefined && headLine === peek.anchor.line
          const showUsages = usagesAnchor !== null && headLine === usagesAnchor.line

          return (
            <Fragment key={index}>
              <DiffLine
                line={line}
                tokenizer={tokenizer}
                anchors={anchors}
                isFlash={isFlash}
                onAnchorClick={handleAnchorClick}
                onShowUsages={setUsagesAnchor}
              />

              {showPeek && peek && peekSpan && (
                <PeekPopup
                  target={target}
                  definition={peek.target}
                  span={peekSpan}
                  truncated={peek.truncated}
                  expanded={peek.expanded}
                  onExpand={nav.expandPeek}
                  onJump={() => nav.jumpToDefinition(peek.anchor)}
                />
              )}

              {showUsages && usagesAnchor && (
                <UsagesPopover anchor={usagesAnchor} onJumpTo={nav.jumpTo} />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
