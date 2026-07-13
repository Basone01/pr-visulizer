import type { ChangedFile, ChangedSymbol, DraftComment } from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { isLineInSelection, selectionRange } from "@/utils/comments/lineSelection"
import { anchorsForLine } from "@/utils/diff/anchors"
import { buildFullFileView } from "@/utils/diff/fullFileView"
import { hideWhitespaceOnly } from "@/utils/diff/hideWhitespaceOnly"
import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"
import { openExternalUrl } from "@/utils/externalLink/openExternal"
import { githubPrFileUrl } from "@/utils/prUrl/githubFileUrl"
import { draftKey } from "@/utils/review/progress"

import type { AnchorIndex, SymbolAnchor } from "@/entity/anchor"
import type { DiffLine as DiffLineVM } from "@/entity/diff"
import type { PrTarget } from "@/entity/pr"

import { fileAtHeadQueryOptions, patchQueryOptions } from "@/service/queries"

import { useDiffFind } from "@/hooks/useDiffFind"
import { useDiffShortcuts } from "@/hooks/useDiffShortcuts"
import { useDiffViewSettings } from "@/hooks/useDiffViewSettings"
import { useLineSelection } from "@/hooks/useLineSelection"
import { useLineTokenizer } from "@/hooks/useLineTokenizer"
import type { PeekNavApi } from "@/hooks/usePeekNavigation"
import { useProgressiveRows } from "@/hooks/useProgressiveRows"

import { CommentComposer } from "./CommentComposer"
import styles from "./Diff.module.css"
import { DiffLine } from "./DiffLine"
import { FindBar } from "./FindBar"
import { PeekPopup } from "./PeekPopup"
import { UsagesPopover } from "./UsagesPopover"

// The composer is anchored to one head line (the range's end) and is either a fresh draft on
// the current selection or an edit of a saved draft; a null means no composer is open.
type ActiveComposer = {
  mode: "new" | "edit"
  startLine: number
  endLine: number
  initialBody: string
  key: string | null
}

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
  // The live "review next" suggestion (same suggestNext the tray highlights, §8.2). null
  // when nothing is left unreviewed — the header's next button is disabled then (task 1).
  suggestedNextPath: string | null
  onOpenFile: (path: string) => void
  onHide: () => void
  // Inline draft comments for THIS file and the write path back to progress (task 5). The
  // three callbacks ride the same optimistic PUT /progress as checkmarks.
  drafts: DraftComment[]
  onAddDraft: (draft: DraftComment) => void
  onUpdateDraft: (key: string, body: string) => void
  onDeleteDraft: (key: string) => void
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

// Shared empty lists, so a line with no anchor or draft keeps the same props across renders
// and the memoized row skips re-rendering.
const NO_ANCHORS: SymbolAnchor[] = []
const NO_DRAFTS: DraftComment[] = []
// Stable reference so the find hook's `lines` dep doesn't churn while the diff is still loading.
const NO_LINES: DiffLineVM[] = []

function fullFileTitleFor(status: ChangedFile["status"], unavailable: boolean): string {
  if (status === "deleted") return "A deleted file's patch is already the whole file"
  if (unavailable) return "Full file unavailable for this file — showing the changed hunks"

  return "View the whole file, not just the changed hunks"
}

function draftsByLineFor(drafts: DraftComment[], path: string): Map<number, DraftComment[]> {
  const byLine = new Map<number, DraftComment[]>()

  for (const draft of drafts) {
    if (draft.path !== path) continue

    const existing = byLine.get(draft.line)
    if (existing) existing.push(draft)
    else byLine.set(draft.line, [draft])
  }

  return byLine
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
  suggestedNextPath,
  onOpenFile,
  onHide,
  drafts,
  onAddDraft,
  onUpdateDraft,
  onDeleteDraft,
}: DiffPaneProps) {
  const path = file?.path ?? ""
  const patchQuery = useQuery(patchQueryOptions(target, path))
  const tokenizer = useLineTokenizer(file?.language ?? null)
  const { settings, toggleWrap, toggleHideWhitespace, toggleFullFile } = useDiffViewSettings()

  // A deleted file has no head revision, and its patch already IS the whole file — the toggle
  // is disabled there rather than fetching content that cannot exist.
  const canShowFullFile = file !== null && file.status !== "deleted"
  const headFileQuery = useQuery(
    fileAtHeadQueryOptions(target, path, settings.fullFile && canShowFullFile)
  )
  // null = not fetched yet, or the client has no head content for this file (see PrClient).
  const headText = headFileQuery.data ?? null
  const fullFileOn = settings.fullFile && headText !== null
  const fullFileUnavailable =
    settings.fullFile && canShowFullFile && !headFileQuery.isPending && headText === null
  const [usagesAnchor, setUsagesAnchor] = useState<SymbolAnchor | null>(null)
  const selection = useLineSelection()
  const [editingKey, setEditingKey] = useState<string | null>(null)

  // A file switch cancels any in-progress selection or edit so the composer never leaks
  // across files.
  useEffect(() => {
    selection.clear()
    setEditingKey(null)
  }, [path, selection.clear])

  // Both are pure view transforms layered over the parse (§10): neither renumbers the head side,
  // so anchors, drafts and find keep resolving in either mode. Full-file re-renders the patch
  // over the whole head file; hide-whitespace then collapses the del/add pairs it finds — the
  // order matters, since the full-file view keeps those pairs adjacent for it. Wrap is CSS-only.
  const parsed = useMemo(() => {
    if (!patchQuery.data) return null

    const base = parseUnifiedDiff(patchQuery.data)
    // Gated on the SETTING, not just on `headText`: a disabled query keeps serving its cached
    // content, so reading the content alone would leave the full view stuck on after a toggle off.
    const view = settings.fullFile && headText !== null ? buildFullFileView(headText, base) : base
    return settings.hideWhitespace ? hideWhitespaceOnly(view) : view
  }, [patchQuery.data, settings.hideWhitespace, settings.fullFile, headText])

  // Mounting (and unmounting) thousands of rows is the longest task a file switch causes, and
  // the click that caused it can't paint until React is done. Deferring the row list drops it
  // to a low-priority render that React time-slices: the click's own feedback — the graph
  // highlight, this header — lands in the next frame, and the rows stream in behind it. The
  // path rides along so the rows on screen always resolve anchors against their own file.
  const diff = useMemo(() => (parsed ? { path, lines: parsed.lines } : null), [parsed, path])
  const shownDiff = useDeferredValue(diff)

  const spanById = useMemo(
    () => new Map(symbols.map((symbol) => [symbol.id, symbol.span])),
    [symbols]
  )

  // Keyed to the rows actually on screen, so a draft pill never lands on the wrong file.
  const draftsByLine = useMemo(
    () => draftsByLineFor(drafts, shownDiff?.path ?? ""),
    [drafts, shownDiff]
  )

  // Size the line-number gutter to the file's widest number — a fixed width overlaps the
  // code on long files (4+ digit line numbers). `ch` tracks the mono digit width.
  const gutterWidth = useMemo(() => {
    if (!shownDiff) return undefined

    let maxLine = 0
    for (const line of shownDiff.lines) {
      if (line.newLine !== null && line.newLine > maxLine) maxLine = line.newLine
      if (line.oldLine !== null && line.oldLine > maxLine) maxLine = line.oldLine
    }

    const digits = Math.max(2, String(maxLine).length)
    return `calc(${digits}ch + 10px)`
  }, [shownDiff])

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

  // An overlay (peek popup, usages list, flash after a jump) can target a row past the first
  // chunk, so growth must reach it immediately rather than a few frames later.
  const overlayLine =
    nav.state.peek?.anchor.line ??
    usagesAnchor?.line ??
    (flash !== null && flash.path === shownDiff?.path ? flash.line : undefined)

  const overlayRequiredRow = useMemo(() => {
    if (!shownDiff || overlayLine === undefined) return -1

    return shownDiff.lines.findIndex((line) => line.newLine === overlayLine)
  }, [shownDiff, overlayLine])

  // Find-in-file (feature 3). The scroll container doubles as the focus target Escape returns to.
  const diffScrollRef = useRef<HTMLDivElement>(null)
  const find = useDiffFind(shownDiff?.lines ?? NO_LINES, diffScrollRef)

  // A far match must stay mounted even if progressive growth hasn't reached it — route it through
  // the same `requiredRow` seam the peek/flash overlays already use (whichever row is deeper).
  const requiredRow = Math.max(overlayRequiredRow, find.open ? find.currentRowIndex : -1)

  const mountedRows = useProgressiveRows(
    shownDiff?.path ?? "",
    shownDiff?.lines.length ?? 0,
    requiredRow
  )

  // Scroll the current match into view once its row is mounted (requiredRow forces the mount in
  // the same commit, so the node is queryable by the time this effect runs).
  const findCurrentRow = find.currentRowIndex
  const findOpen = find.open
  useEffect(() => {
    if (!findOpen || findCurrentRow < 0) return

    const row = diffScrollRef.current?.querySelector("[data-find-current]")
    row?.scrollIntoView({ block: "center" })
  }, [findOpen, findCurrentRow, mountedRows])

  // The row callbacks are hoisted and memoized: a fresh closure per render would defeat
  // DiffLine's memo and re-render (and re-tokenize) every row on any pane state change.
  const { jumpToDefinition, peekUsage } = nav
  const { begin, extend, clear } = selection

  const handleAnchorClick = useCallback(
    (anchor: SymbolAnchor, withMeta: boolean): void => {
      // ⌘/Ctrl-click bypasses the peek and jumps directly (§10).
      if (withMeta) {
        jumpToDefinition(anchor)
        return
      }

      if (anchor.role === "definition") {
        setUsagesAnchor(anchor)
        return
      }

      const span = spanById.get(anchor.symbolId)
      const lineCount = span ? span.endLine - span.startLine + 1 : 1
      peekUsage(anchor, lineCount)
    },
    [jumpToDefinition, peekUsage, spanById]
  )

  const handleSelectLine = useCallback(
    (headLine: number, extendRange: boolean): void => {
      setEditingKey(null)
      if (extendRange) extend(headLine)
      else begin(headLine)
    },
    [begin, extend]
  )

  const openEdit = useCallback(
    (draft: DraftComment): void => {
      clear()
      setEditingKey(draftKey(draft))
    },
    [clear]
  )

  const removeDraft = useCallback(
    (draft: DraftComment): void => {
      const key = draftKey(draft)
      // Read editingKey through the setter so this callback never depends on it — otherwise
      // opening one composer re-renders every row.
      setEditingKey((current) => (current === key ? null : current))
      onDeleteDraft(key)
    },
    [onDeleteDraft]
  )

  // Ctrl+1 / Ctrl+2 (feature 2): the same actions as the ✓ and → toolbar buttons. Guarded to
  // the review screen with a file open; the hook itself declines while a text field is focused.
  const toggleViewedShortcut = useCallback(() => {
    if (path) onToggleReviewed(path)
  }, [path, onToggleReviewed])

  const openNextShortcut = useCallback(() => {
    if (suggestedNextPath) onOpenFile(suggestedNextPath)
  }, [suggestedNextPath, onOpenFile])

  useDiffShortcuts({
    enabled: file !== null,
    onToggleViewed: toggleViewedShortcut,
    onOpenNext: openNextShortcut,
  })

  if (!file) {
    return (
      <div className={styles.pane}>
        <div className={styles.empty}>Select a file from the graph or the review queue.</div>
      </div>
    )
  }

  // `file` is narrowed to non-null here, but nested handlers below are closures that lose that
  // narrowing — capture it once so the draft builders can read the path without a `!`.
  const activeFile = file

  const fileDrafts = drafts.filter((draft) => draft.path === activeFile.path)

  const editingDraft = editingKey
    ? fileDrafts.find((draft) => draftKey(draft) === editingKey)
    : undefined

  // One composer at a time: an open edit wins over a live selection.
  const activeComposer: ActiveComposer | null = editingDraft
    ? {
        mode: "edit",
        startLine: editingDraft.startLine ?? editingDraft.line,
        endLine: editingDraft.line,
        initialBody: editingDraft.body,
        key: editingKey,
      }
    : selection.selection
      ? {
          mode: "new",
          ...selectionRange(selection.selection),
          initialBody: "",
          key: null,
        }
      : null

  function closeComposer(): void {
    selection.clear()
    setEditingKey(null)
  }

  function saveComposer(composer: ActiveComposer, body: string): void {
    if (composer.mode === "edit" && composer.key) {
      onUpdateDraft(composer.key, body)
    } else {
      const draft: DraftComment = {
        path: activeFile.path,
        line: composer.endLine,
        side: "RIGHT",
        body,
        // start_line is sent only for a real multi-line range (§11).
        ...(composer.startLine !== composer.endLine ? { startLine: composer.startLine } : {}),
      }
      onAddDraft(draft)
    }

    closeComposer()
  }

  async function openOnGitHub(path: string): Promise<void> {
    const url = await githubPrFileUrl(target, path)
    await openExternalUrl(url)
  }

  const peek = nav.state.peek
  const peekSpan = peek ? spanById.get(peek.anchor.symbolId) : undefined

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <span className={`${styles.tag} ${STATUS_TAG[file.status]}`}>{file.status}</span>
          <span className={`${styles.churn} mono`}>
            +{file.additions} −{file.deletions}
          </span>
          <span className={styles.spacer} />

          {/* Group 1 — view options + open on GitHub. */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={`${styles.iconToggle} ${settings.wrap ? styles.toggleOn : ""}`}
              aria-pressed={settings.wrap}
              aria-label="Wrap long lines"
              title="Wrap long lines instead of scrolling horizontally"
              onClick={toggleWrap}
            >
              ↵
            </button>
            <button
              type="button"
              className={`${styles.iconToggle} ${settings.hideWhitespace ? styles.toggleOn : ""}`}
              aria-pressed={settings.hideWhitespace}
              aria-label="Hide whitespace-only changes"
              title="Hide whitespace-only changes"
              onClick={toggleHideWhitespace}
            >
              ␣
            </button>
            <button
              type="button"
              className={`${styles.iconToggle} ${fullFileOn ? styles.toggleOn : ""}`}
              aria-pressed={fullFileOn}
              aria-label="View full file"
              title={fullFileTitleFor(file.status, fullFileUnavailable)}
              disabled={!canShowFullFile}
              onClick={toggleFullFile}
            >
              ≡
            </button>
            <button
              type="button"
              className={styles.nextButton}
              aria-label="Open file on GitHub"
              title="Open this file on GitHub"
              onClick={() => void openOnGitHub(file.path)}
            >
              ↗
            </button>
          </div>

          {/* Group 2 — review progress: mark viewed + open next. */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={`${styles.iconToggle} ${reviewed ? styles.toggleOn : ""}`}
              aria-pressed={reviewed}
              aria-label="Mark viewed"
              title={`${reviewed ? "Mark not viewed" : "Mark viewed"} (Ctrl+1)`}
              onClick={() => onToggleReviewed(file.path)}
            >
              ✓
            </button>
            <button
              type="button"
              className={styles.nextButton}
              aria-label="Open next suggested file"
              title={
                suggestedNextPath
                  ? `next: ${baseName(suggestedNextPath)} (Ctrl+2)`
                  : "No unreviewed files left"
              }
              disabled={suggestedNextPath === null}
              onClick={() => suggestedNextPath && onOpenFile(suggestedNextPath)}
            >
              →
            </button>
          </div>

          {/* Group 3 — hide the pane. */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={styles.nextButton}
              aria-label="Hide diff panel"
              title="Hide panel"
              onClick={onHide}
            >
              －
            </button>
          </div>
        </div>
        <div className={styles.titleRow}>
          <span className={`${styles.path} mono`}>{file.path}</span>
        </div>

        {nav.state.jumpStack.length > 0 && (
          <button className={styles.back} onClick={nav.back}>
            ↩ back
          </button>
        )}
      </div>

      <div className={styles.diffRegion}>
        {find.open && <FindBar find={find} />}

        <div
          ref={diffScrollRef}
          tabIndex={-1}
          className={`${styles.diff} ${settings.wrap ? styles.diffWrap : ""}`}
          style={
            gutterWidth ? ({ "--gutter-width": gutterWidth } as React.CSSProperties) : undefined
          }
        >
          {!shownDiff && <div className={styles.empty}>Loading diff…</div>}

          {shownDiff?.lines.slice(0, mountedRows).map((line, index) => {
            const headLine = line.newLine
            const anchors =
              headLine !== null ? anchorsForLine(anchorIndex, shownDiff.path, headLine) : NO_ANCHORS
            const isFlash =
              flash !== null && flash.path === shownDiff.path && flash.line === headLine

            const showPeek =
              peek !== null && peekSpan !== undefined && headLine === peek.anchor.line
            const showUsages = usagesAnchor !== null && headLine === usagesAnchor.line

            const selected = headLine !== null && isLineInSelection(selection.selection, headLine)
            const draftsOnLine =
              headLine !== null ? (draftsByLine.get(headLine) ?? NO_DRAFTS) : NO_DRAFTS
            const showComposer =
              activeComposer !== null && headLine !== null && headLine === activeComposer.endLine

            return (
              <Fragment key={index}>
                <DiffLine
                  line={line}
                  tokenizer={tokenizer}
                  anchors={anchors}
                  isFlash={isFlash}
                  selected={selected}
                  isFindCurrent={find.open && index === find.currentRowIndex}
                  onAnchorClick={handleAnchorClick}
                  onShowUsages={setUsagesAnchor}
                  onSelectLine={handleSelectLine}
                  draftsOnLine={draftsOnLine}
                  onEditDraft={openEdit}
                  onDeleteDraft={removeDraft}
                />

                {showComposer && activeComposer && (
                  <CommentComposer
                    key={`${activeComposer.mode}-${activeComposer.startLine}-${activeComposer.endLine}`}
                    startLine={activeComposer.startLine}
                    endLine={activeComposer.endLine}
                    initialBody={activeComposer.initialBody}
                    onSave={(body) => saveComposer(activeComposer, body)}
                    onCancel={closeComposer}
                  />
                )}

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
    </div>
  )
}
