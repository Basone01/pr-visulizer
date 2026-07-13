import type { Engine, PrMeta } from "@pr-visulizer/shared"

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
}

export function TopBar({ pr, engine, onBack, showSettings, onOpenCloneSettings }: TopBarProps) {
  return (
    <div className={styles.top}>
      <button className={styles.back} onClick={onBack} title="Back to home">
        ← Home
      </button>
      <b>
        PR #{pr.number} — {pr.title}
      </b>
      <span className={styles.badge}>{engineLabel(engine)}</span>

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
    </div>
  )
}
