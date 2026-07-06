import type { TrayRow as TrayRowVM } from "@/entity/viewModels"

import { ReadinessChip } from "./ReadinessChip"
import styles from "./ReviewTray.module.css"

// One queue row (docs/architecture.md §8 / review-tray design). The checkbox toggles
// "reviewed" (optimistic); clicking the path opens that file in the diff pane.
export function TrayRow({
  row,
  onToggle,
  onOpen,
}: {
  row: TrayRowVM
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const className = [styles.row, row.reviewed ? styles.done : "", row.isNext ? styles.next : ""]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={className}>
      <input
        type="checkbox"
        className={styles.check}
        checked={row.reviewed}
        onChange={() => onToggle(row.path)}
        aria-label={`Mark ${row.path} reviewed`}
      />

      <button className={`${styles.path} mono`} onClick={() => onOpen(row.path)}>
        {row.path}
      </button>

      {row.blastRadius !== null && <span className={styles.blast}>⚠️ {row.blastRadius}</span>}

      <ReadinessChip readiness={row.readiness} isNext={row.isNext} reviewed={row.reviewed} />
    </div>
  )
}
