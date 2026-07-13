import styles from "./CollapsedStrip.module.css"

// A collapsed pane, shown as a thin vertical strip with a rotated title and an expand
// button. Clicking anywhere on the strip re-opens the pane (Esc restores all at once).
type CollapsedStripProps = {
  title: string
  onExpand: () => void
}

export function CollapsedStrip({ title, onExpand }: CollapsedStripProps) {
  return (
    <button
      type="button"
      className={styles.strip}
      onClick={onExpand}
      aria-label={`Show ${title} panel`}
      title={`Show ${title}`}
    >
      <span className={styles.plus}>＋</span>
      <span className={styles.label}>{title}</span>
    </button>
  )
}
