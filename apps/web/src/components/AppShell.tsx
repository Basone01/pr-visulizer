import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"

import { DEFAULT_SETTINGS } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"
import { derivePrView } from "@/utils/graph/deriveView"

import type { PrTarget } from "@/entity/pr"

import { analysisQueryOptions } from "@/service/queries"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"
import { useReviewProgress } from "@/hooks/useReviewProgress"
import { type Verdict, useSubmitReview } from "@/hooks/useSubmitReview"

import styles from "./AppShell.module.css"
import { TopBar } from "./TopBar"
import { DiffPane } from "./diff/DiffPane"
import { GraphPane } from "./graph/GraphPane"
import { ReviewTray } from "./tray/ReviewTray"

export function AppShell({ target }: { target: PrTarget }) {
  const analysisQuery = useQuery(analysisQueryOptions(target, "fast"))
  const { progress, toggleReviewed } = useReviewProgress(target)
  const nav = usePeekNavigation("", DEFAULT_SETTINGS.peekMaxLines)
  const { chosenVerdict, setChosenVerdict, submit } = useSubmitReview(target, progress)

  const analysis = analysisQuery.data?.status === "ready" ? analysisQuery.data.result : null

  const view = useMemo(
    () => (analysis && progress ? derivePrView(analysis, progress.reviewedFiles) : null),
    [analysis, progress]
  )

  const anchorIndex = useMemo(
    () => (analysis ? buildAnchorIndex(analysis.occurrences, analysis.symbols) : null),
    [analysis]
  )

  // Default-open the suggested file once the analysis lands (the app-shell design
  // opens straight onto the "next" file).
  const { current } = nav.state
  const { selectFile } = nav
  useEffect(() => {
    if (view && current.path === "") {
      selectFile(view.suggestedPath ?? view.trayRows[0]?.path ?? "")
    }
  }, [view, current.path, selectFile])

  if (!analysis || !view || !progress || !anchorIndex) {
    return (
      <div className={styles.root}>
        <div className={styles.center}>
          {analysisQuery.data?.status === "analyzing" ? "Analyzing PR…" : "Loading PR…"}
        </div>
      </div>
    )
  }

  const currentFile = analysis.files.find((file) => file.path === current.path) ?? null

  return (
    <div className={styles.root}>
      <TopBar pr={analysis.pr} engine={analysis.engine} />

      <div className={styles.shell}>
        <div className={styles.pane}>
          <div className={styles.paneHeader}>
            Dependency graph
            <span className={styles.paneHeaderHint + " mono"}>A → B = depends on</span>
          </div>
          <GraphPane
            fileNodes={view.fileNodes}
            ghostNodes={view.ghostNodes}
            edges={analysis.edges}
            currentPath={current.path}
            onSelect={selectFile}
          />
        </div>

        <div className={styles.pane}>
          <DiffPane
            target={target}
            file={currentFile}
            symbols={analysis.symbols}
            anchorIndex={anchorIndex}
            nav={nav}
            reviewed={progress.reviewedFiles.includes(current.path)}
            onToggleReviewed={toggleReviewed}
          />
        </div>

        <div className={styles.pane}>
          <ReviewTray
            view={view}
            chosenVerdict={chosenVerdict}
            onToggleReviewed={toggleReviewed}
            onOpenFile={selectFile}
            onChooseVerdict={(verdict: Verdict) => setChosenVerdict(verdict)}
            onSubmit={submit}
          />
        </div>
      </div>
    </div>
  )
}
