import { useEffect, useState } from "react"

import {
  ANALYSIS_STEPS,
  ANALYSIS_STEP_LABEL,
  type AnalysisProgress,
  type AnalysisStep,
} from "@/entity/analysisProgress"

import styles from "./AnalysisProgressPanel.module.css"

// The analysis-progress panel (docs/architecture.md §5, task 4). While the graph data is not
// yet ready it takes the graph pane's place and shows the FULL step list — fetching PR →
// reading files → parsing → resolving → ranking — with the current step highlighted and its
// live counter ("reading files 7/23"). http mode has no step events (202-poll), so it renders
// an indeterminate state + elapsed seconds instead of faking per-step progress.

type StepState = "done" | "active" | "pending" | "waiting"

function stepStateAt(index: number, currentIndex: number, indeterminate: boolean): StepState {
  if (currentIndex < 0) return indeterminate ? "waiting" : "pending"
  if (index < currentIndex) return "done"
  if (index === currentIndex) return "active"

  return "pending"
}

export function AnalysisProgressPanel({
  progress,
  indeterminate,
  steps = ANALYSIS_STEPS,
}: {
  progress: AnalysisProgress | null
  indeterminate: boolean
  // Which steps to render: the desktop's full list (incl. preparing-repo) by default; browser
  // modes pass BROWSER_ANALYSIS_STEPS since they never prepare a local repo.
  steps?: AnalysisStep[]
}) {
  const elapsed = useElapsedSeconds(indeterminate)
  const currentIndex = progress ? steps.indexOf(progress.step) : -1

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Analyzing PR…</div>

      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const state = stepStateAt(index, currentIndex, indeterminate)
          const showCounter =
            state === "active" && progress?.done !== undefined && progress?.total !== undefined
          const showDetail = state === "active" && !showCounter && progress?.detail !== undefined

          return (
            <li key={step} className={`${styles.step} ${styles[state]}`} data-state={state}>
              <span className={styles.marker} aria-hidden="true" />
              <span className={styles.label}>{ANALYSIS_STEP_LABEL[step]}</span>
              {showCounter && (
                <span className={`${styles.counter} mono`}>
                  {progress.done}/{progress.total}
                </span>
              )}
              {showDetail && <span className={`${styles.counter} mono`}>{progress.detail}</span>}
            </li>
          )
        })}
      </ol>

      {indeterminate && (
        <div className={styles.elapsed}>
          working… <span className="mono">{elapsed}s</span>
        </div>
      )}
    </div>
  )
}

// A once-per-second elapsed counter, only while indeterminate (http mode). Resets whenever it
// (re)activates so a re-open starts from zero.
function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!active) return

    setSeconds(0)
    const startedAt = Date.now()
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)

    return () => clearInterval(id)
  }, [active])

  return seconds
}
