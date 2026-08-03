import {
  type ChangedFile,
  type ChangedSymbol,
  type DraftComment,
  type ReviewComment,
  shortSha,
} from "@pr-visulizer/shared"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Fragment,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import {
  type CommentThread,
  buildThreads,
  splitThreadsForView,
} from "@/utils/comments/commentThreads"
import { isLineInSelection, selectionRange } from "@/utils/comments/lineSelection"
import { anchorsForLine } from "@/utils/diff/anchors"
import { buildFullFileView } from "@/utils/diff/fullFileView"
import { hideWhitespaceOnly } from "@/utils/diff/hideWhitespaceOnly"
import { buildIntraLineRanges } from "@/utils/diff/intraLineDiff"
import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"
import {
  type SideBySideCell,
  buildSideBySideRows,
  findRowForLineIndex,
} from "@/utils/diff/sideBySideRows"
import { openExternalUrl } from "@/utils/externalLink/openExternal"
import { isMarkdownPath } from "@/utils/markdown/markdownPath"
import { githubPrFileUrl } from "@/utils/prUrl/githubFileUrl"
import { draftKey } from "@/utils/review/progress"

import type { AnchorIndex, SymbolAnchor } from "@/entity/anchor"
import type { DiffLine as DiffLineVM } from "@/entity/diff"
import type { PrTarget } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"
import {
  fileAtHeadQueryOptions,
  patchQueryOptions,
  reviewCommentsQueryOptions,
} from "@/service/queries"

import type { DiffCommitRangeApi } from "@/hooks/useDiffCommitRange"
import { useDiffFind } from "@/hooks/useDiffFind"
import { useDiffShortcuts } from "@/hooks/useDiffShortcuts"
import { useDiffViewSettings } from "@/hooks/useDiffViewSettings"
import { useEscapeKey } from "@/hooks/useEscapeKey"
import { useLineSelection } from "@/hooks/useLineSelection"
import { useLineTokenizer } from "@/hooks/useLineTokenizer"
import type { PeekNavApi } from "@/hooks/usePeekNavigation"
import { useProgressiveRows } from "@/hooks/useProgressiveRows"

import { CommentThreadList } from "@/components/comments/CommentThreadList"
import { MarkdownContent } from "@/components/markdown/MarkdownContent"

import { NO_CHAR_RANGES } from "./CodeContent"
import { CommentComposer } from "./CommentComposer"
import { CommitRangePicker } from "./CommitRangePicker"
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
  // Paths of the PR's changed files — the usages popover groups targets by membership.
  changedPaths: Set<string>
  onOpenFile: (path: string) => void
  onHide: () => void
  // Inline draft comments for THIS file and the write path back to progress (task 5). The
  // three callbacks ride the same optimistic PUT /progress as checkmarks.
  drafts: DraftComment[]
  onAddDraft: (draft: DraftComment) => void
  onUpdateDraft: (key: string, body: string) => void
  onDeleteDraft: (key: string) => void
  // The commit-range lens (§10). With no range selected this changes nothing about the pane —
  // the whole-PR patch renders exactly as it did before the feature existed.
  commitRange: DiffCommitRangeApi
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
// Stable empties so a line/file with no existing comments keeps a constant prop reference.
const NO_THREADS: CommentThread[] = []
const NO_COMMENTS: ReviewComment[] = []

function fullFileTitleFor(status: ChangedFile["status"], unavailable: boolean): string {
  if (status === "deleted") return "A deleted file's patch is already the whole file"
  if (unavailable) return "Full file unavailable for this file — showing the changed hunks"

  return "View the whole file, not just the changed hunks"
}

function previewTitleFor(rangeActive: boolean, unavailable: boolean): string {
  if (rangeActive) return "Preview is unavailable while a commit range is selected"
  if (unavailable) return "Preview unavailable for this file — showing the diff"

  return "Preview the rendered markdown instead of the diff"
}

// Why a bucketed thread can't show inline — shown as the thread's caption in the file bucket.
function bucketCaptionFor(thread: CommentThread): string {
  if (thread.side === "LEFT") return "On the base (removed) side"
  if (thread.anchorLine === null) return "Outdated — this line is no longer in the diff"

  return `On line ${thread.anchorLine}, which isn't shown in the current view`
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
  changedPaths,
  onOpenFile,
  onHide,
  drafts,
  onAddDraft,
  onUpdateDraft,
  onDeleteDraft,
  commitRange,
}: DiffPaneProps) {
  const path = file?.path ?? ""
  const patchQuery = useQuery(patchQueryOptions(target, path))
  const commentsQuery = useQuery(reviewCommentsQueryOptions(target))
  const tokenizer = useLineTokenizer(file?.language ?? null)
  const {
    settings,
    toggleWrap,
    toggleHideWhitespace,
    toggleFullFile,
    toggleSplitView,
    toggleIntraLineDiff,
    toggleMarkdownPreview,
  } = useDiffViewSettings()

  // Which patch this pane is rendering. With no range selected it is the whole-PR patch, byte
  // for byte what it was before commit-range selection existed. With a range selected it is the
  // range's own patch for this file — and `outsideRange` distinguishes "the range doesn't touch
  // this file" (a quiet empty state) from "the patch hasn't arrived yet" (loading).
  const rangeFile = commitRange.range !== null ? commitRange.fileInRange(path) : null
  const rangeActive = commitRange.range !== null && commitRange.rangeDiff !== null
  const outsideRange = rangeActive && rangeFile === null
  const activePatch = commitRange.range !== null ? (rangeFile?.patch ?? null) : patchQuery.data

  // A deleted file has no head revision, and its patch already IS the whole file — the toggle
  // is disabled there rather than fetching content that cannot exist. A range narrows it too:
  // the head content is the PR's head, so overlaying a range patch (which ends at an earlier
  // commit) onto it would renumber lines against the wrong revision. Better to disable the
  // toggle than to render a subtly-wrong file.
  const canShowFullFile = file !== null && file.status !== "deleted" && commitRange.range === null

  // The markdown preview (rendered HEAD revision instead of the diff). Two separate questions,
  // deliberately: whether the toggle EXISTS at all — only a markdown file the app can render, and
  // a deleted one has no head revision to render — and whether it can be used right now.
  const isMarkdownFile = file !== null && file.status !== "deleted" && isMarkdownPath(path)
  // Disabled under a commit range for the same reason full-file is: the preview renders the PR's
  // HEAD, which is not the revision the selected commits describe, so showing it under a range
  // would answer a question the reviewer did not ask.
  const canPreviewMarkdown = isMarkdownFile && commitRange.range === null
  const previewWanted = settings.markdownPreview && canPreviewMarkdown

  // ONE head-content query serves both features — same key, same cache, so a reviewer who used
  // the full-file view on this file pays nothing to preview it.
  const headFileQuery = useQuery(
    fileAtHeadQueryOptions(target, path, (settings.fullFile && canShowFullFile) || previewWanted)
  )
  // null = not fetched yet, or the client has no head content for this file (see PrClient).
  const headText = headFileQuery.data ?? null
  const fullFileOn = settings.fullFile && headText !== null
  const fullFileUnavailable =
    settings.fullFile && canShowFullFile && !headFileQuery.isPending && headText === null

  // Non-null is exactly "render the preview instead of the diff", so the source narrows to string
  // at the one place it is read.
  const previewSource = previewWanted ? headText : null
  const previewPending = previewWanted && headFileQuery.isPending
  const previewUnavailable = previewWanted && !headFileQuery.isPending && headText === null
  const [usagesAnchor, setUsagesAnchor] = useState<SymbolAnchor | null>(null)
  const selection = useLineSelection()
  const [editingKey, setEditingKey] = useState<string | null>(null)

  // A file switch cancels any in-progress selection or edit so the composer never leaks
  // across files.
  useEffect(() => {
    selection.clear()
    setEditingKey(null)
    setExpandedCommentLine(null)
    setBucketOpen(false)
  }, [path, selection.clear])

  // Both are pure view transforms layered over the parse (§10): neither renumbers the head side,
  // so anchors, drafts and find keep resolving in either mode. Full-file re-renders the patch
  // over the whole head file; hide-whitespace then collapses the del/add pairs it finds — the
  // order matters, since the full-file view keeps those pairs adjacent for it. Wrap is CSS-only.
  const parsed = useMemo(() => {
    if (!activePatch) return null

    const base = parseUnifiedDiff(activePatch)
    // Gated on the SETTING, not just on `headText`: a disabled query keeps serving its cached
    // content, so reading the content alone would leave the full view stuck on after a toggle off.
    const view = settings.fullFile && headText !== null ? buildFullFileView(headText, base) : base
    return settings.hideWhitespace ? hideWhitespaceOnly(view) : view
  }, [activePatch, settings.hideWhitespace, settings.fullFile, headText])

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

  // Existing published comment threads for THIS file (§11 "show existing comments"). Built from
  // the whole-PR comment list, filtered to the open file, then split against the head lines
  // actually rendered: anchored threads attach to their row, the rest (outdated, base-side,
  // off-screen) fall into the file bucket below the header.
  const allThreads = useMemo(
    () => buildThreads(commentsQuery.data ?? NO_COMMENTS),
    [commentsQuery.data]
  )
  const fileThreads = useMemo(
    () => allThreads.filter((thread) => thread.path === (shownDiff?.path ?? "")),
    [allThreads, shownDiff]
  )
  const visibleHeadLines = useMemo(() => {
    const lines = new Set<number>()
    if (shownDiff) {
      for (const line of shownDiff.lines) {
        if (line.newLine !== null) lines.add(line.newLine)
      }
    }

    return lines
  }, [shownDiff])
  const { byHeadLine: threadsByLine, bucket: bucketThreads } = useMemo(
    () => splitThreadsForView(fileThreads, visibleHeadLines),
    [fileThreads, visibleHeadLines]
  )

  // Which line's existing-comment thread panel is open (one at a time, like the peek/usages
  // overlays). Keyed by head line — the bubble toggles it; the panel renders under that row.
  const [expandedCommentLine, setExpandedCommentLine] = useState<number | null>(null)
  // The file bucket (outdated / base-side / off-screen threads) starts collapsed so it never
  // pushes the diff down unasked.
  const [bucketOpen, setBucketOpen] = useState(false)

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

  // Character-level emphasis over whatever the transforms above produced (§10). Keyed by FLAT
  // line index, so the inline view and both side-by-side columns look their own side up in the
  // same map. Built only when the toggle is on — off, every line gets the stable NO_CHAR_RANGES
  // and the rows render exactly as they did before the feature existed.
  const intraLineRanges = useMemo(
    () =>
      settings.intraLineDiff && shownDiff ? buildIntraLineRanges({ lines: shownDiff.lines }) : null,
    [settings.intraLineDiff, shownDiff]
  )

  // The last transform in the chain, and the only one that changes the render SHAPE rather than
  // the line list: base-left / head-right pairs over whatever full-file and hide-whitespace
  // produced. null in inline mode, so the flat line list stays the thing being rendered.
  const splitRows = useMemo(
    () =>
      settings.splitView && shownDiff ? buildSideBySideRows({ lines: shownDiff.lines }) : null,
    [settings.splitView, shownDiff]
  )

  // Everything above addresses rows by FLAT line index; pairing breaks that correspondence (an
  // added line can share a row with a deletion three lines earlier), so the mount budget — which
  // counts rendered rows — gets the translated index.
  const renderRowCount = splitRows ? splitRows.length : (shownDiff?.lines.length ?? 0)
  const requiredRenderRow = splitRows ? findRowForLineIndex(splitRows, requiredRow) : requiredRow

  // The mode rides in the key: switching it changes what a row IS, so growth restarts rather than
  // carrying a flat-line budget over to a shorter paired list.
  const mountedRows = useProgressiveRows(
    `${shownDiff?.path ?? ""}${settings.splitView ? ":split" : ""}`,
    renderRowCount,
    requiredRenderRow
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
  const { select, extend, clear } = selection

  // A bubble click toggles that line's thread panel — second click (same line) collapses it.
  const handleToggleThread = useCallback((headLine: number): void => {
    setExpandedCommentLine((current) => (current === headLine ? null : headLine))
  }, [])

  // Escape closes an open thread panel — claimed only while one is open, and below find, peek
  // and the line selection, so it never closes the panel out from under them.
  useEscapeKey("threadPanel", expandedCommentLine !== null, () => setExpandedCommentLine(null))

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

  // A gutter click either runs the click-click range machine (plain click: anchor, then
  // complete, then start over) or extends from the anchor (shift-click). Both live in the
  // pure selection state machine — this only routes the modifier.
  const handleSelectLine = useCallback(
    (headLine: number, extendRange: boolean): void => {
      setEditingKey(null)
      if (extendRange) extend(headLine)
      else select(headLine)
    },
    [select, extend]
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
    commentNow.reset()
  }

  // "Comment now" (§11): publish immediately instead of drafting. Success closes the
  // composer like a save; failure keeps it open with the error inline, text intact.
  const commentNow = useMutation({
    mutationFn: (draft: DraftComment) => getPrClient().addCommentNow(target, draft),
    onSuccess: () => {
      selection.clear()
      setEditingKey(null)
    },
  })

  function publishComposerNow(composer: ActiveComposer, body: string): void {
    commentNow.mutate({
      path: activeFile.path,
      line: composer.endLine,
      side: "RIGHT",
      body,
      ...(composer.startLine !== composer.endLine ? { startLine: composer.startLine } : {}),
    })
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

  // One code line, one rendering: the inline row and BOTH side-by-side columns come through here,
  // so a line never has a second copy of its markup to keep in sync. `gutterSide` is the only
  // difference — the base column shows the base number and drops the head-anchored annotations.
  function renderLine(cell: SideBySideCell, path: string, gutterSide: "head" | "base"): ReactNode {
    const headLine = cell.line.newLine
    const anchors = headLine !== null ? anchorsForLine(anchorIndex, path, headLine) : NO_ANCHORS
    const isFlash = flash !== null && flash.path === path && flash.line === headLine
    const selected = headLine !== null && isLineInSelection(selection.selection, headLine)
    const draftsOnLine = headLine !== null ? (draftsByLine.get(headLine) ?? NO_DRAFTS) : NO_DRAFTS
    const threadsOnLine =
      headLine !== null ? (threadsByLine.get(headLine) ?? NO_THREADS) : NO_THREADS

    return (
      <DiffLine
        line={cell.line}
        tokenizer={tokenizer}
        anchors={anchors}
        isFlash={isFlash}
        selected={selected}
        isFindCurrent={find.open && cell.index === find.currentRowIndex}
        gutterSide={gutterSide}
        onAnchorClick={handleAnchorClick}
        onShowUsages={setUsagesAnchor}
        onSelectLine={handleSelectLine}
        draftsOnLine={draftsOnLine}
        onEditDraft={openEdit}
        onDeleteDraft={removeDraft}
        threadsOnLine={threadsOnLine}
        onToggleThread={handleToggleThread}
        charRanges={intraLineRanges?.get(cell.index) ?? NO_CHAR_RANGES}
      />
    )
  }

  // The three things that open UNDER a row — composer, peek, usages — all anchor to a head line,
  // so both modes place them by that line and split mode simply spans them across both columns.
  // Returns null when the row has none, so split mode adds no empty table rows.
  function renderRowOverlays(headLine: number | null): ReactNode {
    if (headLine === null) return null

    const showComposer = activeComposer !== null && headLine === activeComposer.endLine
    const showPeek = peek !== null && peekSpan !== undefined && headLine === peek.anchor.line
    const showUsages = usagesAnchor !== null && headLine === usagesAnchor.line
    const showThreads = expandedCommentLine === headLine && threadsByLine.has(headLine)
    if (!showComposer && !showPeek && !showUsages && !showThreads) return null

    return (
      <>
        {showThreads && (
          <div className={styles.threadPanel}>
            <CommentThreadList threads={threadsByLine.get(headLine) ?? NO_THREADS} />
          </div>
        )}

        {showComposer && activeComposer && (
          <CommentComposer
            key={`${activeComposer.mode}-${activeComposer.startLine}-${activeComposer.endLine}`}
            startLine={activeComposer.startLine}
            endLine={activeComposer.endLine}
            initialBody={activeComposer.initialBody}
            onSave={(body) => saveComposer(activeComposer, body)}
            onSaveNow={
              activeComposer.mode === "new"
                ? (body) => publishComposerNow(activeComposer, body)
                : undefined
            }
            savingNow={commentNow.isPending}
            saveNowError={commentNow.error ? String(commentNow.error) : null}
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
            onClose={nav.closePeek}
          />
        )}

        {showUsages && usagesAnchor && (
          <UsagesPopover anchor={usagesAnchor} changedPaths={changedPaths} onJumpTo={nav.jumpTo} />
        )}
      </>
    )
  }

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
              className={`${styles.iconToggle} ${settings.splitView ? styles.toggleOn : ""}`}
              aria-pressed={settings.splitView}
              aria-label="Side-by-side view"
              title="Compare side by side — removed on the left, added on the right"
              onClick={toggleSplitView}
            >
              ◫
            </button>
            <button
              type="button"
              className={`${styles.iconToggle} ${settings.intraLineDiff ? styles.toggleOn : ""}`}
              aria-pressed={settings.intraLineDiff}
              aria-label="Highlight changed characters"
              title="Highlight only the characters that changed within a line"
              onClick={toggleIntraLineDiff}
            >
              Aa
            </button>
            {/* Markdown-only, so the toolbar stays the same width on every other file. */}
            {isMarkdownFile && (
              <button
                type="button"
                className={`${styles.iconToggle} ${previewSource !== null ? styles.toggleOn : ""}`}
                aria-pressed={previewSource !== null}
                aria-label="Preview rendered markdown"
                title={previewTitleFor(commitRange.range !== null, previewUnavailable)}
                disabled={!canPreviewMarkdown}
                onClick={toggleMarkdownPreview}
              >
                ¶
              </button>
            )}
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
              title={`${reviewed ? "Mark not viewed" : "Mark viewed"} (⌥1)`}
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
                  ? `next: ${baseName(suggestedNextPath)} (⌥2)`
                  : "No unreviewed files left"
              }
              disabled={suggestedNextPath === null}
              onClick={() => suggestedNextPath && onOpenFile(suggestedNextPath)}
            >
              →
            </button>
          </div>

          {/* Group 3 — commit-range picker + hide the pane. */}
          <div className={styles.toolGroup}>
            <div className={styles.pickerAnchor}>
              <button
                type="button"
                className={`${styles.iconToggle} ${commitRange.range ? styles.toggleOn : ""}`}
                aria-pressed={commitRange.range !== null}
                aria-haspopup="dialog"
                aria-expanded={commitRange.pickerOpen}
                aria-label="Changes from commits"
                title="Show changes from selected commits only"
                onClick={commitRange.pickerOpen ? commitRange.closePicker : commitRange.openPicker}
              >
                ⑂
              </button>

              {commitRange.pickerOpen && (
                <CommitRangePicker
                  commits={commitRange.commits}
                  selection={commitRange.selection}
                  truncated={commitRange.commitsTruncated}
                  onSelect={commitRange.select}
                  onClear={commitRange.clear}
                  onClose={commitRange.closePicker}
                />
              )}
            </div>

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

        {commitRange.range && (
          <div className={styles.rangeChip} role="status">
            <span className={styles.rangeLabel}>
              commits{" "}
              <span className="mono">
                {shortSha(commitRange.range.baseSha)}…{shortSha(commitRange.range.headSha)}
              </span>
              {commitRange.rangeDiff && ` · ${commitRange.fileCount} files`}
            </span>
            <button
              type="button"
              className={styles.rangeReset}
              onClick={commitRange.clear}
              title="Show all changes in this PR"
            >
              show all changes
            </button>
          </div>
        )}

        {nav.state.jumpStack.length > 0 && (
          <button className={styles.back} onClick={nav.back}>
            ↩ back
          </button>
        )}
      </div>

      <div className={styles.diffRegion}>
        {/* Find, comments and symbol anchors all address DIFF lines — none of them has a meaning
            in a rendered document, so the preview simply replaces the whole diff area and the
            toggle is the way back to them. */}
        {find.open && previewSource === null && <FindBar find={find} />}

        {previewPending && <div className={styles.empty}>Loading preview…</div>}

        {previewSource !== null && (
          <div className={styles.previewRegion}>
            <MarkdownContent source={previewSource} />
          </div>
        )}

        {previewSource === null && !previewPending && (
          <div
            ref={diffScrollRef}
            tabIndex={-1}
            className={`${styles.diff} ${settings.wrap ? styles.diffWrap : ""}`}
            style={
              gutterWidth ? ({ "--gutter-width": gutterWidth } as React.CSSProperties) : undefined
            }
          >
            {/* Threads that can't anchor inline — outdated, base-side, or on a line the current
                view hides. Collapsed by default so they never shove the diff down unasked. */}
            {bucketThreads.length > 0 && (
              <div className={styles.commentBucket}>
                <button
                  type="button"
                  className={styles.commentBucketToggle}
                  aria-expanded={bucketOpen}
                  onClick={() => setBucketOpen((open) => !open)}
                >
                  {bucketOpen ? "▾" : "▸"} {bucketThreads.length} comment
                  {bucketThreads.length === 1 ? "" : "s"} not shown inline
                </button>

                {bucketOpen && (
                  <div className={styles.commentBucketBody}>
                    <CommentThreadList threads={bucketThreads} captionFor={bucketCaptionFor} />
                  </div>
                )}
              </div>
            )}

            {/* A file the selected commits never touched is a normal, expected state — say so
              quietly and offer the way back, rather than showing an error or an endless spinner.
              This also catches a range patch GitHub omits (a rename with no content change),
              which is why the copy talks about changes rather than about a missing patch. */}
            {outsideRange && (
              <div className={styles.rangeEmpty}>
                <p>No changes in the selected commits.</p>
                <button type="button" className={styles.rangeReset} onClick={commitRange.clear}>
                  show all changes
                </button>
              </div>
            )}

            {!outsideRange && commitRange.error && (
              <div className={styles.empty} role="alert">
                Couldn't load the diff for these commits — {commitRange.error}
              </div>
            )}

            {!outsideRange && !commitRange.error && !shownDiff && (
              <div className={styles.empty}>Loading diff…</div>
            )}

            {shownDiff &&
              !splitRows &&
              shownDiff.lines.slice(0, mountedRows).map((line, index) => (
                <Fragment key={index}>
                  {renderLine({ line, index }, shownDiff.path, "head")}
                  {renderRowOverlays(line.newLine)}
                </Fragment>
              ))}

            {shownDiff && splitRows && (
              <table className={styles.split}>
                <tbody>
                  {splitRows.slice(0, mountedRows).map((row, rowIndex) => {
                    // A hunk header belongs to neither side — it spans the table like the separator
                    // it is, and keeps the head gutter so find still resolves it.
                    if (row.kind === "hunk") {
                      return (
                        <tr key={rowIndex}>
                          <td className={styles.splitCell} colSpan={2}>
                            {renderLine(row.header, shownDiff.path, "head")}
                          </td>
                        </tr>
                      )
                    }

                    const overlays = renderRowOverlays(row.right?.line.newLine ?? null)

                    return (
                      <Fragment key={rowIndex}>
                        <tr>
                          <td
                            className={`${styles.splitCell} ${row.left ? "" : styles.splitFiller}`}
                          >
                            {row.left && renderLine(row.left, shownDiff.path, "base")}
                          </td>
                          <td
                            className={`${styles.splitCell} ${row.right ? "" : styles.splitFiller}`}
                          >
                            {row.right && renderLine(row.right, shownDiff.path, "head")}
                          </td>
                        </tr>

                        {overlays && (
                          <tr>
                            <td colSpan={2}>{overlays}</td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
