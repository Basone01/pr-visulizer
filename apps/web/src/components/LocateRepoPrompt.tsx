import styles from "./LocateRepoPrompt.module.css"

// The locate-vs-clone prompt (docs/tauri-architecture.md §6, deep-only desktop). Rendered in
// the progress-panel area on first open when the PR's repo has no linked local clone AND no
// managed clone root: deep analysis needs somewhere to read the repo from. Preferred path is
// linking the user's EXISTING clone (fast — no network clone); "Clone it for me" falls back
// to the managed clone flow. Dumb component: the AppShell owns the picker/link logic.

type LocateRepoPromptProps = {
  slug: string // owner/repo
  error: string | null
  busy: boolean
  onLocate: () => void
  onClone: () => void
}

export function LocateRepoPrompt({ slug, error, busy, onLocate, onClone }: LocateRepoPromptProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.title}>Deep analysis reads from a local clone</div>

      <p className={styles.body}>
        No local clone of <span className="mono">{slug}</span> is linked yet. Point at the clone you
        already have — analysis reads the PR head from its git database and never touches your
        working tree or branches.
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button className={styles.primary} onClick={onLocate} disabled={busy}>
          {busy ? "Opening…" : "Locate local clone…"}
        </button>
        <button className={styles.secondary} onClick={onClone} disabled={busy}>
          Clone it for me
        </button>
      </div>
    </div>
  )
}
