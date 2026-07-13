import { type ReactNode, useCallback, useEffect, useState } from "react"

import { type TauriBootResult, bootstrapTauri } from "@/tauri/bootstrap"

import styles from "./TauriGate.module.css"

// The desktop startup gate (docs/tauri-architecture.md §5): before the data-consuming App
// renders, run gh-token auth + the CLI deep-link. A failure shows a full-window message with
// a retry — the §5 error table — and success renders the App with the client already wired.
// Only reachable in Tauri mode (main.tsx code-splits it), so no plugin loads in web mode.

type BootError = Extract<TauriBootResult, { ok: false }>["error"]

type GateState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: BootError }

const MESSAGES: Record<BootError, { title: string; hint: string }> = {
  "gh-missing": {
    title: "GitHub CLI not found",
    hint: "brew install gh",
  },
  "gh-not-authed": {
    title: "GitHub CLI is not signed in",
    hint: "gh auth login",
  },
}

export function TauriGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "loading" })

  const run = useCallback(async () => {
    setState({ kind: "loading" })
    const result = await bootstrapTauri()
    setState(result.ok ? { kind: "ready" } : { kind: "error", error: result.error })
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  if (state.kind === "ready") return <>{children}</>

  if (state.kind === "error") {
    const message = MESSAGES[state.error]
    return (
      <div className={styles.root}>
        <div className={styles.card}>
          <h1 className={styles.title}>{message.title}</h1>
          <p className={styles.instruction}>Run this in a terminal, then retry:</p>
          <code className={`${styles.command} mono`}>{message.hint}</code>
          <button className={styles.retry} onClick={() => void run()}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <p className={styles.instruction}>Starting PR Visualizer…</p>
      </div>
    </div>
  )
}
