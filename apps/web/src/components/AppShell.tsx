import { type Engine, suggestNextInOrder } from "@pr-visulizer/shared"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"

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
import { type PaneId, usePaneCollapse } from "@/hooks/usePaneCollapse"
import { usePanelSizes } from "@/hooks/usePanelSizes"
import { usePeekNavigation } from "@/hooks/usePeekNavigation"
import { useQueueMode } from "@/hooks/useQueueMode"
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
import { TopBar } from "./TopBar"
import { DiffPane } from "./diff/DiffPane"
import { GraphPane } from "./graph/GraphPane"
import { ReviewTray } from "./tray/ReviewTray"

// Desktop analysis steps track the precision preset (config/settings.ts): tier on shows the
// "precise-linking" step the worker actually reports; tier off must not render a dead step.
const TAURI_ANALYSIS_STEPS =
  DESKTOP_PRECISION_PRESET === "off" ? ANALYSIS_STEPS : DEEP_V2_ANALYSIS_STEPS

// Which clone-folder modal is open: the "Clone it for me" path (auto-retry the analysis after
// picking) or the gear settings path (just save). Null = closed.
type CloneModal = "clone" | "settings" | null

export function AppShell({ target, onBack }: { target: PrTarget; onBack: () => void }) {
  // The desktop is deep-only (docs/tauri-architecture.md §6): opening a PR runs the full deep
  // pipeline automatically. Browser modes keep the fast engine. Review progress is a separate
  // query keyed by PR (not engine), so checkmarks/drafts are engine-independent.
  const engine: Engine = env.tauriMode ? "deep" : "fast"
  const [cloneModal, setCloneModal] = useState<CloneModal>(null)
  const [cloneRoot, setCloneRoot] = useState<string | null>(null)
  const [locateError, setLocateError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)

  // The overview is a separate, fast query (§9): meta + file list, rendered the moment it lands
  // while the (slower) analysis is still computing. Live step progress rides its own seam.
  const overviewQuery = useQuery(overviewQueryOptions(target))
  const analysisQuery = useQuery(analysisQueryOptions(target, engine))
  const viewerQuery = useQuery(viewerQueryOptions())
  const analysisProgress = useAnalysisProgress(target)
  const { progress, toggleReviewed, saveDraft, editDraft, removeDraft } = useReviewProgress(target)
  const panels = usePanelSizes()
  const collapse = usePaneCollapse()
  const queueMode = useQueueMode()
  const nav = usePeekNavigation("", DEFAULT_SETTINGS.peekMaxLines)
  const { chosenVerdict, setChosenVerdict, submit } = useSubmitReview(target, progress)

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

    if (retry) void analysisQuery.refetch()
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
  const { selectFile } = nav

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
  // (3) panels hidden and nothing focused → restore every pane. Yields to the diff's own Esc
  // (peek/jump), which owns Escape while a peek is open or the jump stack is non-empty (§10).
  //
  // CAPTURE phase (the `true` below) is required: a focused React Flow node's key handling
  // calls stopPropagation on Escape, so a bubble-phase window listener never fires on a real
  // keypress (only synthetic dispatch reached it). Capturing at the window runs first, before
  // any child can swallow the event.
  const peekActive = nav.state.peek !== null || nav.state.jumpStack.length > 0
  const { restoreAll, focusGraph, collapsed } = collapse
  useEffect(() => {
    if (peekActive) return

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return

      // Suppress the webview's native Escape default — in the packaged WKWebView a real
      // Escape reloads the page, which instantly undoes the collapse (synthetic events don't
      // trigger native defaults, so this only bites real keypresses).
      event.preventDefault()

      // While a text field owns focus (comment composer, find-in-file bar), Escape belongs to
      // that field — close find, cancel an edit — not to collapsing the panes.
      if (isEditableTarget(document.activeElement)) return

      if (!collapsed.diff) focusGraph()
      else if (current.path !== "") selectFile("")
      else restoreAll()
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [peekActive, collapsed.diff, current.path, selectFile, restoreAll, focusGraph])

  // Gate on the OVERVIEW (a fast gateway read), not the full analysis (task 4): the shell
  // renders the instant it has the PR meta + file list; the graph and ranking fill in later.
  // While even the overview is still loading, show the fetch/analysis TIMELINE (not a bare
  // spinner) so the reviewer sees what's happening — fetching PR → reading files → … — rather
  // than waiting on a blank screen.
  if (!overview || !view || !progress) {
    return (
      <div className={styles.root}>
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

  const pr = analysis?.pr ?? overview.pr
  const shownEngine = analysis?.engine ?? engine
  const files = analysis?.files ?? overview.files
  const currentFile = files.find((file) => file.path === current.path) ?? null

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

  return (
    <div className={styles.root}>
      <TopBar
        pr={pr}
        engine={shownEngine}
        onBack={onBack}
        showSettings={env.tauriMode}
        onOpenCloneSettings={() => setCloneModal("settings")}
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

      {cloneModal && (
        <CloneRootModal
          currentCloneRoot={cloneRoot}
          onChosen={onCloneRootChosen}
          onClose={closeCloneModal}
        />
      )}

      <div
        className={styles.shell}
        data-shell
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
              />
            ) : needsRepoSource ? (
              <LocateRepoPrompt
                slug={repoKey(target)}
                error={locateError}
                busy={locating}
                onLocate={() => void onLocateRepo()}
                onClone={() => setCloneModal("clone")}
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
          <div className={`${styles.pane} ${styles.centerPane}`}>
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
              <DiffPane
                target={target}
                file={currentFile}
                symbols={analysis?.symbols ?? []}
                anchorIndex={anchorIndex}
                nav={nav}
                reviewed={progress.reviewedFiles.includes(current.path)}
                onToggleReviewed={toggleReviewed}
                suggestedNextPath={nextFilePath}
                onOpenFile={selectFile}
                onHide={() => collapse.toggle("diff")}
                drafts={progress.drafts}
                onAddDraft={saveDraft}
                onUpdateDraft={editDraft}
                onDeleteDraft={removeDraft}
              />
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
            />
          </div>
        )}
      </div>
    </div>
  )
}
