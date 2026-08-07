import styles from "./LocateRepoPrompt.module.css"

// The locate-vs-clone chooser (docs/tauri-architecture.md §6, deep-only desktop). Shown when the
// PR's repo has no linked local clone AND no managed clone root: deep analysis needs somewhere to
// read the repo from. Preferred path is linking the clone the user already has (fast — no network
// clone); "Clone it for me" falls back to the managed clone flow.
//
// A MODAL rather than a panel: with no repo source there is nothing behind it to read, so the
// choice is the screen. Cancel is the way out, back to the home list.
//
// Dumb component: the AppShell owns the picker, the link and the clone.

type LocateRepoPromptProps = {
  slug: string // owner/repo
  error: string | null
  busy: boolean
  // The live clone phase while "Clone it for me" runs, or null when nothing is cloning. It keeps
  // the modal up and explains the wait HERE — a first clone of a large repo is minutes long, and
  // handing that off to the panel behind the modal read as "the chooser vanished, now what".
  preparing: string | null
  onLocate: () => void
  onClone: () => void
  onCancel: () => void
}

export function LocateRepoPrompt({
  slug,
  error,
  busy,
  preparing,
  onLocate,
  onClone,
  onCancel,
}: LocateRepoPromptProps) {
  return (
    // The backdrop closes on click like the clone-folder modal, so the two behave the same.
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.card} onClick={(event) => event.stopPropagation()}>
        <h3 className={styles.title}>
          No local clone for <span className="mono">{slug}</span>
        </h3>

        <p className={styles.body}>
          Deep analysis reads the PR head from a local git database, so it needs a copy of this
          repository. Point at the clone you already have, or let it clone one for you — either way
          it never touches your working tree or branches.
        </p>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {preparing === null ? (
          <div className={styles.actions}>
            <button className={styles.cancel} onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className={styles.secondary} onClick={onClone} disabled={busy}>
              Clone it for me…
            </button>
            <button className={styles.primary} onClick={onLocate} disabled={busy}>
              {busy ? "Opening…" : "Locate local clone…"}
            </button>
          </div>
        ) : (
          <>
            <p className={styles.progress} role="status">
              {preparing}
            </p>
            <div className={styles.actions}>
              {/* Still an exit: the clone keeps running and the next open reuses it. */}
              <button className={styles.cancel} onClick={onCancel}>
                Back to home
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
