import styles from "./ReviewedProgressChip.module.css"

// Reviewed-progress overlay on the graph canvas (top-left): "✓ reviewed/total" changed files.
// Clicking jumps to the first still-unreviewed file (tray order). When every file is reviewed the
// chip stays, shows the full count, and is disabled — success-toned, no dead click.
export function ReviewedProgressChip({
  reviewedCount,
  totalCount,
  firstUnreviewedPath,
  onOpen,
}: {
  reviewedCount: number
  totalCount: number
  // null = nothing left unreviewed → the chip is the all-done state.
  firstUnreviewedPath: string | null
  onOpen: (path: string) => void
}) {
  const allReviewed = firstUnreviewedPath === null

  return (
    <button
      type="button"
      className={`${styles.chip} ${allReviewed ? styles.done : ""}`}
      disabled={allReviewed}
      aria-disabled={allReviewed}
      aria-label={
        allReviewed
          ? `All ${totalCount} files reviewed`
          : `${reviewedCount} of ${totalCount} files reviewed — open first unreviewed file`
      }
      title={allReviewed ? "All files reviewed" : "Open the first unreviewed file"}
      onClick={() => firstUnreviewedPath && onOpen(firstUnreviewedPath)}
    >
      <span className={styles.check} aria-hidden="true">
        ✓
      </span>
      <span className="mono">
        {reviewedCount}/{totalCount}
      </span>
    </button>
  )
}
