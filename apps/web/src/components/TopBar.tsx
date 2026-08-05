import type { Engine, PrMeta } from "@pr-visulizer/shared"
import { useState } from "react"

import { PrDescriptionPanel } from "./PrDescriptionPanel"
import { ThemeSwitch } from "./ThemeSwitch"
import styles from "./TopBar.module.css"

// Engine label mirrors the design badge: "FAST · AST" (fast) / "DEEP · REPO" (deep — repo-wide
// AST, §6 v1). The desktop is deep-only (docs/tauri-architecture.md §6), so in tauri mode the
// badge always reads DEEP · REPO; the old "Deepen analysis" button is gone — deep runs
// automatically on open. The gear (clone-folder settings) survives, desktop only.
function engineLabel(engine: Engine): string {
  return engine === "fast" ? "FAST · AST" : "DEEP · REPO"
}

type TopBarProps = {
  pr: PrMeta
  engine: Engine
  onBack: () => void
  // Desktop only: the gear that opens the clone-folder settings modal.
  showSettings: boolean
  onOpenCloneSettings: () => void
  // Re-read the PR at its current head — commits pushed since the app opened it.
  onRefresh: () => void
  refreshing: boolean
}

export function TopBar({
  pr,
  engine,
  onBack,
  showSettings,
  onOpenCloneSettings,
  onRefresh,
  refreshing,
}: TopBarProps) {
  // Description-viewer open state is trivial UI state that belongs with the button controlling
  // it — kept local so the panel stays a self-contained overlay and the review flow is untouched.
  const [showDescription, setShowDescription] = useState(false)

  return (
    <div className={styles.top}>
      <button className={styles.back} onClick={onBack} title="Back to home">
        ← Home
      </button>
      <b>
        PR #{pr.number} — {pr.title}
      </b>
      <button
        className={styles.info}
        onClick={() => setShowDescription(true)}
        title="View PR description"
        aria-label="View PR description"
      >
        ⓘ
      </button>
      <span className={styles.badge}>{engineLabel(engine)}</span>

      <button
        className={`${styles.refresh} ${refreshing ? styles.spinning : ""}`}
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh this PR"
        aria-label="Refresh PR"
      >
        ↻
      </button>

      {showSettings && (
        <button
          className={styles.gear}
          onClick={onOpenCloneSettings}
          title="Clone folder settings"
          aria-label="Clone folder settings"
        >
          ⚙️
        </button>
      )}

      <span className={styles.spacer} />
      <span className={`${styles.meta} mono`}>
        {pr.owner}/{pr.repo} · headSha {pr.headSha.slice(0, 7)}
      </span>
      <ThemeSwitch />

      {showDescription && <PrDescriptionPanel pr={pr} onClose={() => setShowDescription(false)} />}
    </div>
  )
}
