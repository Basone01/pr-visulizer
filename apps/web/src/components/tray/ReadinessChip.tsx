import styles from "./ReviewTray.module.css"

// readiness(f) = reviewed changed-deps / total changed-deps (§8.2). 1.00 means full
// context right now. The chip is the right-hand status cell of a tray row: a check
// once reviewed, the "next" marker on the suggestion, else the live readiness value.
export function ReadinessChip({
  readiness,
  isNext,
  reviewed,
}: {
  readiness: number
  isNext: boolean
  reviewed: boolean
}) {
  if (reviewed) {
    return (
      <span className={styles.ok} data-testid="readiness-chip">
        ✓
      </span>
    )
  }

  if (isNext) {
    return (
      <span className={styles.next} data-testid="readiness-chip">
        👉 next
      </span>
    )
  }

  return (
    <span className={`${styles.readiness} mono`} data-testid="readiness-chip">
      {readiness.toFixed(2)}
    </span>
  )
}
