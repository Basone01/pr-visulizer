import { languageForPath } from "@pr-visulizer/engine"
import type { SymbolOccurrence } from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef } from "react"

import { openExternalUrl } from "@/utils/externalLink/openExternal"

import type { DiffLine as DiffLineVM } from "@/entity/diff"
import type { PrTarget } from "@/entity/pr"

import { fileAtHeadQueryOptions } from "@/service/queries"

import { useDiffFind } from "@/hooks/useDiffFind"
import { useLineTokenizer } from "@/hooks/useLineTokenizer"
import { useProgressiveRows } from "@/hooks/useProgressiveRows"

import styles from "./Diff.module.css"
import { DiffLine } from "./DiffLine"
import { FindBar } from "./FindBar"

// Read-only viewer for a GHOST file (§6: unchanged, references changed code — context, never
// work). Renders the whole head-revision file with the referencing lines highlighted. It is
// deliberately NOT DiffPane: no diff, no review checkbox, no comments (GitHub can't take review
// comments on an unchanged file), no view toggles — just content, refs, find, and navigation.
type GhostFilePaneProps = {
  target: PrTarget
  path: string
  // This PR's head sha — the GitHub link points at the blob here, because a ghost file has no
  // anchor in the PR's "Files changed" tab.
  headSha: string
  // Occurrences of changed symbols inside THIS file (already filtered by path).
  refs: SymbolOccurrence[]
  suggestedNextPath: string | null
  onOpenFile: (path: string) => void
  onHide: () => void
}

// DiffLine's interaction props are review-only concerns; a ghost row never uses them. Module-
// level constants keep every row's props referentially stable for the memo.
const NO_OP = (): void => {}
const NO_ANCHORS: never[] = []
const NO_DRAFTS: never[] = []

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

// Same trailing-newline artifact the diff parser drops — a file ending in "\n" must not gain a
// phantom blank last row.
function toContextLines(headText: string): DiffLineVM[] {
  const raw = headText.split("\n")
  if (raw.at(-1) === "") raw.pop()

  return raw.map((content, index) => ({
    kind: "context" as const,
    content,
    oldLine: index + 1,
    newLine: index + 1,
  }))
}

export function GhostFilePane({
  target,
  path,
  headSha,
  refs,
  suggestedNextPath,
  onOpenFile,
  onHide,
}: GhostFilePaneProps) {
  const contentQuery = useQuery(fileAtHeadQueryOptions(target, path, true))
  const tokenizer = useLineTokenizer(languageForPath(path))
  const scrollRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(
    () => (contentQuery.data ? toContextLines(contentQuery.data) : []),
    [contentQuery.data]
  )

  const refLineSet = useMemo(() => new Set(refs.map((ref) => ref.line)), [refs])
  const firstRefRow = useMemo(() => {
    const first = Math.min(...refs.map((ref) => ref.line))
    return Number.isFinite(first) ? first - 1 : -1
  }, [refs])

  const find = useDiffFind(lines, scrollRef)

  // The first referencing line and the current find match must be mounted immediately — the
  // same force-mount seam DiffPane's overlays use.
  const requiredRow = Math.max(firstRefRow, find.open ? find.currentRowIndex : -1)
  const mountedRows = useProgressiveRows(path, lines.length, requiredRow)

  // Open on the first referencing line: that line is WHY this file is on the graph.
  useEffect(() => {
    if (lines.length === 0) return

    // Optional call: jsdom has no scrollIntoView, and the highlight matters more than the scroll.
    const row = scrollRef.current?.querySelector("[data-ghost-ref]")
    row?.scrollIntoView?.({ block: "center" })
  }, [lines, path])

  const findCurrentRow = find.currentRowIndex
  const findOpen = find.open
  useEffect(() => {
    if (!findOpen || findCurrentRow < 0) return

    const row = scrollRef.current?.querySelector("[data-find-current]")
    row?.scrollIntoView?.({ block: "center" })
  }, [findOpen, findCurrentRow, mountedRows])

  async function openOnGitHub(): Promise<void> {
    await openExternalUrl(
      `https://github.com/${target.owner}/${target.repo}/blob/${headSha}/${path}`
    )
  }

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <span className={`${styles.tag} ${styles.tagGhost}`}>unchanged</span>
          <span className={`${styles.churn} mono`}>
            {refs.length} ref{refs.length === 1 ? "" : "s"} to changed code
          </span>
          <span className={styles.spacer} />
          <span className={styles.toolGroup}>
            <button
              type="button"
              className={styles.nextButton}
              aria-label="Open file on GitHub"
              title="Open this file at the PR's head on GitHub"
              onClick={() => void openOnGitHub()}
            >
              ↗
            </button>
          </span>
          <span className={styles.toolGroup}>
            <button
              type="button"
              className={styles.nextButton}
              aria-label="Open next suggested file"
              title={
                suggestedNextPath
                  ? `next: ${baseName(suggestedNextPath)}`
                  : "No unreviewed files left"
              }
              disabled={suggestedNextPath === null}
              onClick={() => suggestedNextPath && onOpenFile(suggestedNextPath)}
            >
              →
            </button>
          </span>
          <span className={styles.toolGroup}>
            <button
              type="button"
              className={styles.nextButton}
              aria-label="Hide diff panel"
              title="Hide panel"
              onClick={onHide}
            >
              －
            </button>
          </span>
        </div>
        <div className={styles.titleRow}>
          <span className={`${styles.path} mono`}>{path}</span>
        </div>
      </div>

      <div className={styles.diffRegion}>
        {find.open && <FindBar find={find} />}
        <div ref={scrollRef} className={styles.diff} tabIndex={-1}>
          {contentQuery.isPending && <div className={styles.empty}>Loading file…</div>}
          {contentQuery.data === null && (
            <div className={styles.empty}>File content isn't available in this mode.</div>
          )}
          {lines.slice(0, mountedRows).map((line, index) => (
            <div
              key={index}
              data-ghost-ref={refLineSet.has(line.newLine ?? -1) || undefined}
              className={refLineSet.has(line.newLine ?? -1) ? styles.ghostRef : undefined}
            >
              <DiffLine
                line={line}
                tokenizer={tokenizer}
                anchors={NO_ANCHORS}
                isFlash={false}
                selected={false}
                isFindCurrent={find.open && index === find.currentRowIndex}
                onAnchorClick={NO_OP}
                onShowUsages={NO_OP}
                onSelectLine={NO_OP}
                onLineDragEnter={NO_OP}
                draftsOnLine={NO_DRAFTS}
                onEditDraft={NO_OP}
                onDeleteDraft={NO_OP}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
