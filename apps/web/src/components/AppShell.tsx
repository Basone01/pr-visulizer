import { type Engine, suggestNextInOrder } from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"

import { env } from "@/config/env"
import { DEFAULT_SETTINGS, DESKTOP_PRECISION_PRESET } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"
import { isEditableTarget } from "@/utils/dom/isEditableTarget"
import { deriveOverview, derivePrView } from "@/utils/graph/deriveView"

import {
  ANALYSIS_STEPS,
  BROWSER_ANALYSIS_STEPS,
  DEEP_V2_ANALYSIS_STEPS,
} from "@/entity/analysisProgress"
import type { PrTarget } from "@/entity/pr"
import { repoKey } from "@/entity/pr"
import { isNeedsRepoSourceError } from "@/entity/repoSource"

import { getAppStorage } from "@/service/clientFactory"
import { analysisQueryOptions, overviewQueryOptions, viewerQueryOptions } from "@/service/queries"

import { useAnalysisProgress } from "@/hooks/useAnalysisProgress"
import { useDiffCommitRange } from "@/hooks/useDiffCommitRange"
import { useEscapeKey } from "@/hooks/useEscapeKey"
import { type PaneId, usePaneCollapse } from "@/hooks/usePaneCollapse"
import {
  MIN_CENTER_PANE,
  MIN_CODEX_HEIGHT,
  MIN_CODEX_PANE,
  MIN_SIDE_PANE,
  usePanelSizes,
} from "@/hooks/usePanelSizes"
import { usePeekNavigation } from "@/hooks/usePeekNavigation"
import { useQueueMode } from "@/hooks/useQueueMode"
import { useRecentFiles } from "@/hooks/useRecentFiles"
import { useRefreshPr } from "@/hooks/useRefreshPr"
import { useReviewProgress } from "@/hooks/useReviewProgress"
import { type Verdict, useSubmitReview } from "@/hooks/useSubmitReview"

import { getCloneRoot } from "@/tauri/cloneRoot"
import { linkLocalRepo } from "@/tauri/linkLocalRepo"

import { AnalysisProgressPanel } from "./AnalysisProgressPanel"
import styles from "./AppShell.module.css"
import { CloneRootModal } from "./CloneRootModal"
import { CollapsedStrip } from "./CollapsedStrip"
import { ErrorBoundary } from "./ErrorBoundary"
import { LocateRepoPrompt } from "./LocateRepoPrompt"
import { PaneDivider } from "./PaneDivider"
import { RecentFilesPalette } from "./RecentFilesPalette"
import { TopBar } from "./TopBar"
import { AiReviewPanel } from "./aiReview/AiReviewPanel"
import { DiffPane } from "./diff/DiffPane"
import { GhostFilePane } from "./diff/GhostFilePane"
import { GraphPane } from "./graph/GraphPane"
import { ReviewTray } from "./tray/ReviewTray"

// Desktop analysis steps track the precision preset (config/settings.ts): tier on shows the
// "precise-linking" step the worker actually reports; tier off must not render a dead step.
const TAURI_ANALYSIS_STEPS =
  DESKTOP_PRECISION_PRESET === "off" ? ANALYSIS_STEPS : DEEP_V2_ANALYSIS_STEPS
const answerOpenFileEventSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
})

// Which clone-folder modal is open: the "Clone it for me" path (auto-retry the analysis after
// picking) or the gear settings path (just save). Null = closed.
type CloneModal = "clone" | "settings" | null

export function AppShell({ target, onBack }: { target: PrTarget; onBack: () => void }) {
  // The desktop is deep-only (docs/tauri-architecture.md §6): opening a PR runs the full deep
  // pipeline automatically. Browser modes keep the fast engine. Review progress is a separate
  // query keyed by PR (not engine), so checkmarks/drafts are engine-independent.
  const engine: Engine = env.tauriMode ? "deep" : "fast"
  const [cloneModal, setCloneModal] = useState<CloneModal>(null)
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const handleTerminalSessionEnded = useCallback((sessionId: string) => {
    setActiveTerminalSessionId((currentSessionId) =>
      currentSessionId === sessionId ? null : currentSessionId
    )
  }, [])
  const [cloneRoot, setCloneRoot] = useState<string | null>(null)
  const [locateError, setLocateError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  // True from "Clone it for me" until the retried analysis settles. It keeps the chooser modal up
  // so the clone's phases have somewhere to show — without it the modal closes the instant the
  // repo source resolves and the wait moves to the panel behind it.
  const [cloning, setCloning] = useState(false)
  // The overview is a separate, fast query (§9): meta + file list, rendered the moment it lands
  // while the (slower) analysis is still computing. Live step progress rides its own seam.
  const overviewQuery = useQuery(overviewQueryOptions(target))
  const analysisQuery = useQuery(analysisQueryOptions(target, engine))
  const viewerQuery = useQuery(viewerQueryOptions())
  const analysisProgress = useAnalysisProgress(target)
  // The diff pane's commit-range lens (§10). It lives HERE, not inside DiffPane, for one reason:
  // the tray also reads it — to mute rows outside the range — and PR-screen state is the one
  // place both panes can share. Deliberately not persisted: a fresh open shows the whole PR.
  const commitRange = useDiffCommitRange(target, overviewQuery.data?.pr.baseSha ?? "")
  const { progress, toggleReviewed, saveDraft, editDraft, removeDraft, discardDrafts } =
    useReviewProgress(target)
  const panels = usePanelSizes()
  const collapse = usePaneCollapse()
  const queueMode = useQueueMode()
  const nav = usePeekNavigation("", DEFAULT_SETTINGS.peekMaxLines)
  const { refresh, isRefreshing } = useRefreshPr(target)
  const {
    chosenVerdict,
    setChosenVerdict,
    submit,
    isSubmitting,
    isSubmitted,
    submitError,
    resetSubmit,
  } = useSubmitReview(target, progress, discardDrafts)

  // The retried analysis has settled (either way) — the clone, if there was one, is over.
  useEffect(() => {
    if (!analysisQuery.isFetching) setCloning(false)
  }, [analysisQuery.isFetching])

  // Load the persisted clone folder once (desktop only) so the modal can show/change it.
  useEffect(() => {
    if (!env.tauriMode) return

    void getCloneRoot().then(setCloneRoot)
  }, [])

  // No linked clone and no clone root — the client rejects with the typed error; render the
  // locate-vs-clone prompt in the progress-panel area (docs/tauri-architecture.md §6).
  const needsRepoSource = isNeedsRepoSourceError(analysisQuery.error)

  async function onCloneRootChosen(path: string): Promise<void> {
    // The persist MUST land before the retry — the client re-reads the store, and an
    // unawaited write makes it see null and bounce the prompt straight back.
    await setCloneRoot(path)

    const retry = cloneModal === "clone"
    setCloneModal(null)

    if (retry) {
      setCloning(true)
      void analysisQuery.refetch()
    }
  }

  // "Locate local clone…": pick a folder, validate its origin against this PR's repo,
  // register the link, and re-run the analysis (which now selects the linked source).
  async function onLocateRepo(): Promise<void> {
    setLocating(true)
    setLocateError(null)
    try {
      const outcome = await linkLocalRepo(getAppStorage(), target)
      if (outcome.status === "linked") void analysisQuery.refetch()
      else if (outcome.status === "error") setLocateError(outcome.message)
    } finally {
      setLocating(false)
    }
  }

  function closeCloneModal(): void {
    setCloneModal(null)
  }

  // A commit range is a lens on the commit list the refresh is about to replace, and the
  // selection is held as INDEXES into it: after a force-push those indexes can name different
  // commits, so a refresh drops back to the whole PR — the state a fresh open already shows.
  function refreshPr(): void {
    commitRange.clear()
    refresh()
  }

  // The chooser owns the screen whenever the repo has no local source, and stays up through a
  // clone it started. Built once and rendered from both paths below, so it appears the moment
  // resolution fails rather than waiting for the overview to arrive first.
  const clonePhase =
    cloning && analysisProgress?.step === "preparing-repo"
      ? (analysisProgress.detail ?? "Preparing the local clone…")
      : cloning
        ? "Preparing the local clone…"
        : null

  const repoSourceModal =
    needsRepoSource || cloning ? (
      <LocateRepoPrompt
        slug={repoKey(target)}
        error={locateError}
        busy={locating}
        preparing={clonePhase}
        onLocate={() => void onLocateRepo()}
        onClone={() => setCloneModal("clone")}
        onCancel={onBack}
      />
    ) : null

  const analysis = analysisQuery.data?.status === "ready" ? analysisQuery.data.result : null
  const overview = overviewQuery.data ?? null

  // Once analysis lands, the full view (ranking + graph + suggestion) supersedes the
  // provisional overview view (file list only). The tray renders whichever is available.
  const fullView = useMemo(
    () =>
      analysis && progress
        ? derivePrView(analysis, progress.reviewedFiles, progress.drafts, queueMode.mode)
        : null,
    [analysis, progress, queueMode.mode]
  )
  const provisionalView = useMemo(
    () =>
      overview && progress
        ? deriveOverview(overview, progress.reviewedFiles, progress.drafts)
        : null,
    [overview, progress]
  )
  const view = fullView ?? provisionalView

  const anchorIndex = useMemo(
    () => buildAnchorIndex(analysis?.occurrences ?? [], analysis?.symbols ?? []),
    [analysis]
  )

  // Default-open the suggested file once the analysis lands (the app-shell design
  // opens straight onto the "next" file).
  const { current } = nav.state
  const { jumpTo, selectFile } = nav
  const isDiffCollapsedRef = useRef(collapse.collapsed.diff)
  isDiffCollapsedRef.current = collapse.collapsed.diff

  useEffect(() => {
    if (!env.tauriMode) return

    let active = true
    let unlisten: (() => void) | null = null
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("codex-answer://open-file", (event: { payload: unknown }) => {
          const payload = answerOpenFileEventSchema.safeParse(event.payload)
          if (payload.success && payload.data.sessionId === activeTerminalSessionId) {
            if (isDiffCollapsedRef.current) collapse.toggle("diff")

            if (payload.data.line) jumpTo({ path: payload.data.path, line: payload.data.line })
            else selectFile(payload.data.path)
          }
        })
      )
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [activeTerminalSessionId, collapse.toggle, jumpTo, selectFile])

  // Clicking a graph node opens its diff — expanding the diff pane if the reviewer had it
  // collapsed, so a click never selects a file whose diff is hidden.
  function openFromGraph(path: string): void {
    selectFile(path)
    if (collapse.collapsed.diff) collapse.toggle("diff")
  }

  // The "next" button walks the review QUEUE relative to the OPEN file — the next unreviewed
  // file after the current one (wrapping to the first unreviewed), never the current file
  // itself. `view.suggestedPath` (the readiness pick) can't do this: it stays on the best
  // unreviewed file until you check it off, so it kept re-pointing at the file you're viewing.
  const nextFilePath = useMemo(() => {
    if (!view) return null

    const rows = view.trayRows
    const currentIndex = rows.findIndex((row) => row.path === current.path)
    const after = rows.slice(currentIndex + 1).find((row) => !row.reviewed)
    if (after) return after.path

    const wrapped = rows.find((row) => !row.reviewed && row.path !== current.path)
    return wrapped?.path ?? null
  }, [view, current.path])

  // The graph's reviewed-progress chip jumps to the FIRST unreviewed file in tray order,
  // regardless of queue mode — the same pick the chain-mode suggestion uses (§8.4). Reuses the
  // ranking core's `suggestNextInOrder`; null once every file is reviewed.
  const firstUnreviewedPath = useMemo(
    () =>
      view
        ? suggestNextInOrder(
            view.trayRows.map((row) => row.path),
            progress?.reviewedFiles ?? []
          )
        : null,
    [view, progress]
  )
  // Paths of the PR's changed files — the ⌘P palette searches this list, and the usages popover
  // splits targets into in-PR vs ghost by membership in it.
  const filePaths = useMemo(
    () => (analysis?.files ?? overview?.files ?? []).map((file) => file.path),
    [analysis, overview]
  )
  const changedPaths = useMemo(() => new Set(filePaths), [filePaths])

  // The files the reviewer has moved through — the ⌘P switcher's list. Tracked here (above the
  // loading gate below) so a refetch that briefly drops the overview can't wipe the history.
  const recentFiles = useRecentFiles(current.path)

  // Occurrences of changed symbols in the OPEN path — the ghost pane's highlight lines. Cheap
  // for changed files too (unused there), which keeps the hook above the early returns.
  const ghostRefs = useMemo(
    () => (analysis?.occurrences ?? []).filter((occ) => occ.path === current.path),
    [analysis, current.path]
  )

  // Auto-open the suggested file ONCE, when the analysis first lands. Guarded so a later manual
  // blur (Esc clearing the focus) stays blurred instead of snapping straight back to the
  // suggestion the moment current.path goes empty.
  const didAutoOpen = useRef(false)
  useEffect(() => {
    if (didAutoOpen.current || !view || current.path !== "") return

    didAutoOpen.current = true
    selectFile(view.suggestedPath ?? view.trayRows[0]?.path ?? "")
  }, [view, current.path, selectFile])

  // Escape progressively zooms out: (1) diff visible → collapse diff + tray to focus the graph;
  // (2) diff already hidden but a node is focused → blur the node (clear selection + dimming);
  // (3) panels hidden and nothing focused → restore every pane. This is the OUTERMOST layer, so
  // it runs only when no overlay, peek, selection or panel claimed the key first.
  const { restoreAll, focusGraph, collapsed } = collapse
  useEscapeKey("paneCollapse", true, () => {
    // A text field can own focus with nothing else open (a composer draft, a tray filter) —
    // Escape belongs to that field, not to collapsing the panes.
    if (isEditableTarget(document.activeElement)) return

    if (!collapsed.diff) focusGraph()
    else if (current.path !== "") selectFile("")
    else restoreAll()
  })

  const pr = analysis?.pr ?? overview?.pr ?? null
  const shownEngine = analysis?.engine ?? engine
  const files = analysis?.files ?? overview?.files ?? []
  const currentFile = files.find((file) => file.path === current.path) ?? null

  // Gate on the OVERVIEW (a fast gateway read), not the full analysis (task 4): the shell
  // renders the instant it has the PR meta + file list; the graph and ranking fill in later.
  // While even the overview is still loading, show the fetch/analysis TIMELINE (not a bare
  // spinner) so the reviewer sees what's happening — fetching PR → reading files → … — rather
  // than waiting on a blank screen.
  if (!overview || !view || !progress || !pr) {
    return (
      <div className={styles.root}>
        {repoSourceModal}
        <div className={styles.center}>
          <AnalysisProgressPanel
            progress={analysisProgress}
            indeterminate={!env.tauriMode && !env.fixtureMode}
            steps={env.tauriMode ? TAURI_ANALYSIS_STEPS : BROWSER_ANALYSIS_STEPS}
          />
        </div>
      </div>
    )
  }

  // The open path can be a GHOST node (unchanged file referencing changed code) — those aren't
  // in `files`, so they render the read-only GhostFilePane instead of the diff.
  const currentGhost = currentFile
    ? null
    : (fullView?.ghostNodes.find((ghost) => ghost.path === current.path) ?? null)

  // http mode has no step events (202-poll) — the progress panel renders its indeterminate
  // state instead of highlighting a step it can't observe.
  const indeterminateProgress = !env.tauriMode && !env.fixtureMode

  // A real analysis failure (not the locate-vs-clone prompt case) surfaces on the error bar.
  const analysisFailure =
    analysisQuery.error && !needsRepoSource
      ? analysisQuery.error instanceof Error
        ? analysisQuery.error.message
        : String(analysisQuery.error)
      : null

  // GitHub forbids approving your own PR (§11): disable Approve when the viewer is the author.
  const approveDisabled = viewerQuery.data?.login === pr.author

  // Exactly one expanded pane fills the remaining width (flex:1); the others keep their fixed
  // widths or collapse to a strip. Priority diff → graph → tray, so collapsing the center still
  // fills the row with no gap.
  const fillerPane: PaneId = !collapse.collapsed.diff
    ? "diff"
    : !collapse.collapsed.graph
      ? "graph"
      : "tray"
  const graphReservedWidth =
    collapse.collapsed.graph || fillerPane === "graph" ? 34 : panels.sizes.graph
  const trayReservedWidth =
    collapse.collapsed.tray || fillerPane === "tray" ? 34 : panels.sizes.tray
  const minimumShellWidth =
    graphReservedWidth +
    (collapse.collapsed.diff ? 34 : MIN_CENTER_PANE) +
    trayReservedWidth +
    (!collapse.collapsed.graph && !collapse.collapsed.diff ? 6 : 0) +
    (!collapse.collapsed.tray && !collapse.collapsed.diff ? 6 : 0)

  return (
    <div className={styles.root}>
      <TopBar
        pr={pr}
        engine={shownEngine}
        onBack={onBack}
        showSettings={env.tauriMode}
        onOpenCloneSettings={() => setCloneModal("settings")}
        onRefresh={refreshPr}
        refreshing={isRefreshing}
      />

      {analysisFailure && (
        <div className={styles.errorBar} role="alert">
          <span className={styles.errorText}>Analysis failed — {analysisFailure}</span>
          <button
            className={styles.errorClose}
            onClick={() => void analysisQuery.refetch()}
            aria-label="Retry analysis"
            title="Retry"
          >
            ↻
          </button>
        </div>
      )}

      {repoSourceModal}

      <RecentFilesPalette recentFiles={recentFiles} filePaths={filePaths} onOpenFile={selectFile} />

      {cloneModal && (
        <CloneRootModal
          currentCloneRoot={cloneRoot}
          onChosen={onCloneRootChosen}
          onClose={closeCloneModal}
        />
      )}

      <div
        className={styles.workspace}
        data-workspace
        style={
          {
            "--codex-width": `${panels.sizes.codex}px`,
            "--codex-height": `${panels.sizes.codexHeight}px`,
          } as React.CSSProperties
        }
      >
        <div
          className={styles.shell}
          data-shell
          data-pane-min-width={minimumShellWidth}
          data-pane-min-height={MIN_CENTER_PANE}
          style={
            {
              "--graph-width": `${panels.sizes.graph}px`,
              "--tray-width": `${panels.sizes.tray}px`,
            } as React.CSSProperties
          }
        >
          {collapse.collapsed.graph ? (
            <CollapsedStrip title="Dependency graph" onExpand={() => collapse.toggle("graph")} />
          ) : (
            <div
              className={`${styles.pane} ${styles.sidePane} ${styles.graphPane}`}
              data-pane-id="graph"
              data-pane-min-width={MIN_SIDE_PANE}
              data-pane-fixed={fillerPane === "diff" ? "true" : undefined}
              style={fillerPane === "graph" ? { flex: "1 1 0", width: "auto" } : undefined}
            >
              <div className={styles.paneHeader}>
                Dependency graph
                <span className={styles.paneHeaderHint + " mono"}>A → B = depends on</span>
                <button
                  type="button"
                  className={styles.hideButton}
                  aria-label="Hide dependency graph"
                  title="Hide panel"
                  onClick={() => collapse.toggle("graph")}
                >
                  －
                </button>
              </div>
              {analysis ? (
                <GraphPane
                  fileNodes={view.fileNodes}
                  ghostNodes={view.ghostNodes}
                  edges={analysis.edges}
                  currentPath={current.path}
                  onSelect={openFromGraph}
                  reviewedCount={view.reviewedCount}
                  totalCount={view.totalCount}
                  firstUnreviewedPath={firstUnreviewedPath}
                  rangeTouchedPaths={commitRange.touchedPaths}
                />
              ) : (
                <AnalysisProgressPanel
                  progress={analysisProgress}
                  indeterminate={indeterminateProgress}
                  steps={env.tauriMode ? TAURI_ANALYSIS_STEPS : BROWSER_ANALYSIS_STEPS}
                />
              )}
            </div>
          )}

          {!collapse.collapsed.graph && !collapse.collapsed.diff && (
            <PaneDivider
              ariaLabel="Resize graph pane"
              cssVar="--graph-width"
              direction={1}
              onCommit={(px) => panels.commit({ graph: px })}
              onReset={panels.reset}
            />
          )}

          {collapse.collapsed.diff ? (
            <CollapsedStrip title="Diff" onExpand={() => collapse.toggle("diff")} />
          ) : (
            <div
              className={`${styles.pane} ${styles.centerPane}`}
              data-pane-id="diff"
              data-pane-min-width={MIN_CENTER_PANE}
            >
              <ErrorBoundary
                key={current.path}
                fallback={(error) => (
                  <div className={styles.diffError} role="alert">
                    <p>Couldn't render this diff.</p>
                    <p className={styles.diffErrorDetail}>{error.message}</p>
                    <button onClick={() => nextFilePath && selectFile(nextFilePath)}>
                      Open next file
                    </button>
                  </div>
                )}
              >
                {currentGhost ? (
                  <GhostFilePane
                    target={target}
                    path={currentGhost.path}
                    headSha={pr.headSha}
                    refs={ghostRefs}
                    suggestedNextPath={nextFilePath}
                    onOpenFile={selectFile}
                    onHide={() => collapse.toggle("diff")}
                  />
                ) : (
                  <DiffPane
                    target={target}
                    file={currentFile}
                    symbols={analysis?.symbols ?? []}
                    anchorIndex={anchorIndex}
                    nav={nav}
                    reviewed={progress.reviewedFiles.includes(current.path)}
                    onToggleReviewed={toggleReviewed}
                    suggestedNextPath={nextFilePath}
                    changedPaths={changedPaths}
                    onOpenFile={selectFile}
                    onHide={() => collapse.toggle("diff")}
                    drafts={progress.drafts}
                    onAddDraft={saveDraft}
                    onUpdateDraft={editDraft}
                    onDeleteDraft={removeDraft}
                    commitRange={commitRange}
                  />
                )}
              </ErrorBoundary>
            </div>
          )}

          {!collapse.collapsed.tray && !collapse.collapsed.diff && (
            <PaneDivider
              ariaLabel="Resize review tray"
              cssVar="--tray-width"
              direction={-1}
              onCommit={(px) => panels.commit({ tray: px })}
              onReset={panels.reset}
            />
          )}

          {collapse.collapsed.tray ? (
            <CollapsedStrip title="Review queue" onExpand={() => collapse.toggle("tray")} />
          ) : (
            <div
              className={`${styles.pane} ${styles.sidePane} ${styles.trayPane}`}
              data-pane-id="tray"
              data-pane-min-width={MIN_SIDE_PANE}
              data-pane-fixed={fillerPane === "diff" ? "true" : undefined}
              style={fillerPane === "tray" ? { flex: "1 1 0", width: "auto" } : undefined}
            >
              <ReviewTray
                view={view}
                activePath={current.path}
                queueMode={queueMode.mode}
                onChooseQueueMode={queueMode.choose}
                chosenVerdict={chosenVerdict}
                approveDisabled={approveDisabled}
                onToggleReviewed={toggleReviewed}
                onOpenFile={selectFile}
                onHide={() => collapse.toggle("tray")}
                onChooseVerdict={(verdict: Verdict) => setChosenVerdict(verdict)}
                onSubmit={submit}
                commentCount={progress.drafts.length}
                isSubmitting={isSubmitting}
                isSubmitted={isSubmitted}
                submitError={submitError}
                onResetSubmit={resetSubmit}
                viewedSyncError={
                  progress.viewedSync?.status === "degraded"
                    ? (progress.viewedSync.reason ?? "GitHub sync failed")
                    : null
                }
                rangeTouchedPaths={commitRange.touchedPaths}
              />
            </div>
          )}
        </div>

        {env.tauriMode && (
          <PaneDivider
            ariaLabel="Resize Codex pane"
            cssVar="--codex-width"
            direction={-1}
            minWidth={MIN_CODEX_PANE}
            onCommit={(px) => panels.commit({ codex: px })}
            onReset={panels.reset}
          />
        )}

        {env.tauriMode && (
          <PaneDivider
            ariaLabel="Resize Codex height"
            cssVar="--codex-height"
            direction={-1}
            minWidth={MIN_CODEX_HEIGHT}
            orientation="horizontal"
            className={styles.codexHeightDivider}
            onCommit={(px) => panels.commit({ codexHeight: px })}
            onReset={panels.reset}
          />
        )}

        {env.tauriMode && (
          <AiReviewPanel
            target={target}
            storage={getAppStorage()}
            title={pr.title}
            baseSha={pr.baseSha}
            headSha={pr.headSha}
            currentFilePath={current.path || null}
            onTerminalSessionStarted={setActiveTerminalSessionId}
            onTerminalSessionEnded={handleTerminalSessionEnded}
          />
        )}
      </div>
    </div>
  )
}
