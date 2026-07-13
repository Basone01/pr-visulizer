import { useState } from "react"

import { pickCloneRoot, setCloneRoot } from "@/tauri/cloneRoot"

import styles from "./CloneRootModal.module.css"

// The clone-folder settings modal (docs/tauri-architecture.md §6 deep mode). Opened the first
// time "Deepen analysis 🔬" is pressed with no folder set, or from the gear affordance to change
// it. Explains why deep mode needs a local folder, shows the current one (with "change"), and
// runs the native picker. On a successful pick it persists the path and calls `onChosen`, which
// the caller uses to retry the deepen straight away.

type CloneRootModalProps = {
  currentCloneRoot: string | null
  onChosen: (path: string) => void
  onClose: () => void
}

export function CloneRootModal({ currentCloneRoot, onChosen, onClose }: CloneRootModalProps) {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(): Promise<void> {
    setPicking(true)
    setError(null)
    try {
      const path = await pickCloneRoot()
      if (!path) return // cancelled — leave the modal open

      await setCloneRoot(path)
      onChosen(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not open the folder picker")
    } finally {
      setPicking(false)
    }
  }

  const chooseLabel = currentCloneRoot ? "Change folder…" : "Choose folder…"

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.card} onClick={(event) => event.stopPropagation()}>
        <h3 className={styles.title}>Deep analysis needs a clone folder</h3>

        <p className={styles.body}>
          Deep mode clones the repository to your machine and indexes the whole checkout, so it can
          show unchanged files that reference the change. Pick one folder — clones live under{" "}
          <span className="mono">&lt;folder&gt;/owner/repo</span> and are reused across PRs.
        </p>

        {currentCloneRoot && (
          <div className={styles.current}>
            <span className={styles.currentLabel}>Current folder</span>
            <span className={`${styles.currentPath} mono`}>{currentCloneRoot}</span>
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button className={styles.secondary} onClick={onClose} disabled={picking}>
            Cancel
          </button>
          <button className={styles.primary} onClick={choose} disabled={picking}>
            {picking ? "Opening…" : chooseLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
