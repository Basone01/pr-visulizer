import type { Engine, PrMeta } from "@pr-visulizer/shared"

import styles from "./TopBar.module.css"

// Engine label mirrors the design badge: "FAST · AST" (fast) / "DEEP · LSP" (deep).
function engineLabel(engine: Engine): string {
  return engine === "fast" ? "FAST · AST" : "DEEP · LSP"
}

export function TopBar({ pr, engine }: { pr: PrMeta; engine: Engine }) {
  return (
    <div className={styles.top}>
      <b>
        PR #{pr.number} — {pr.title}
      </b>
      <span className={styles.badge}>{engineLabel(engine)}</span>

      {/* The deep engine (§6) is a later slice — surfaced but disabled with a reason. */}
      <button className={styles.deepen} disabled title="deep engine not built yet">
        Deepen analysis 🔬
      </button>

      <span className={styles.spacer} />
      <span className={`${styles.meta} mono`}>
        {pr.owner}/{pr.repo} · headSha {pr.headSha.slice(0, 7)}
      </span>
    </div>
  )
}
