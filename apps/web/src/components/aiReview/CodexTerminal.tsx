import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useEffect, useRef, useState } from "react"

import { env } from "@/config/env"

import { type SelectableAiProviderId, TERMINAL_PROVIDERS } from "@/entity/aiReviewSettings"
import type { TerminalPromptShortcut } from "@/entity/terminalPromptShortcuts"

import { showAnswerWindow, subscribeAnswerReports } from "@/service/terminal/answerWindow"
import {
  type CodexTerminalContext,
  type CodexTerminalSession,
  startCodexTerminal,
} from "@/service/terminal/codexTerminal"

import styles from "./AiReviewPanel.module.css"

type CodexTerminalProps = {
  provider: SelectableAiProviderId
  shortcuts: ReadonlyArray<TerminalPromptShortcut>
  repositoryPath: string | null
  initialPrompt: string
  model: string | null
  terminalIdentity: string
  onSessionStarted: (sessionId: string) => void
  onSessionEnded: (sessionId: string) => void
  context: CodexTerminalContext
}

function createSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `codex-terminal-${Date.now()}-${Math.random()}`
}

function terminalSize(fitAddon: FitAddon, terminal: Terminal): { rows: number; cols: number } {
  fitAddon.fit()
  return { rows: terminal.rows, cols: terminal.cols }
}

const MAX_QUEUED_INPUT_BYTES = 64 * 1024

export function CodexTerminal({
  provider,
  shortcuts,
  repositoryPath,
  initialPrompt,
  model,
  terminalIdentity,
  onSessionStarted,
  onSessionEnded,
  context,
}: CodexTerminalProps) {
  const label = TERMINAL_PROVIDERS[provider].label
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const sessionRef = useRef<CodexTerminalSession | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "stopped" | "error">(
    "idle"
  )
  const [message, setMessage] = useState<string | null>(null)
  // 0 means the reviewer has not pressed Start yet, Start and Restart both bump it.
  const [launchKey, setLaunchKey] = useState(0)
  // A provider or model change never launches: it drops back to idle in every state.
  // Resetting during render (not in an effect) means the start effect never sees
  // the old launchKey paired with the new provider, so nothing starts even briefly.
  const [launchTarget, setLaunchTarget] = useState({ provider, model })
  if (launchTarget.provider !== provider || launchTarget.model !== model) {
    setLaunchTarget({ provider, model })
    setLaunchKey(0)
  }
  const stopRequestedRef = useRef(false)
  const [hasAnswer, setHasAnswer] = useState(false)
  const contextRef = useRef(context)
  contextRef.current = context

  useEffect(() => {
    setHasAnswer(false)
    if (!env.tauriMode) {
      setStatus("error")
      setMessage(`The ${label} terminal is available in the desktop app.`)
      return
    }
    if (repositoryPath === null) {
      setStatus("error")
      setMessage(`Link this repository before starting ${label}.`)
      return
    }
    if (launchKey === 0) {
      setStatus("idle")
      setMessage(`Press Start to launch ${label}.`)
      return
    }
    const host = hostRef.current
    if (host === null) return

    let active = true
    let exited = false
    let pendingInput: string[] = []
    let pendingInputBytes = 0
    let drainingInput = false
    const sessionId = createSessionId()
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      theme: { background: "#0f172a", foreground: "#e2e8f0" },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminal.focus()
    terminalRef.current = terminal
    activeSessionIdRef.current = sessionId
    const initialSize = terminalSize(fitAddon, terminal)
    let pendingResize: { rows: number; cols: number } | null = null
    let resizing = false
    function resize(): void {
      const session = sessionRef.current
      if (!active || session === null) return

      pendingResize = terminalSize(fitAddon, terminal)
      if (resizing) return

      resizing = true
      void (async () => {
        try {
          while (pendingResize) {
            const nextSize = pendingResize
            pendingResize = null
            await session.resize(nextSize.rows, nextSize.cols)
          }
        } finally {
          resizing = false
        }
      })().catch(() => undefined)
    }
    let answerUnlisten: (() => void) | null = null
    void subscribeAnswerReports(sessionId, () => {
      if (active) setHasAnswer(true)
    })
      .then((unlisten) => {
        // Cleanup may already have run (StrictMode double-run), so release a late listener now.
        if (active) answerUnlisten = unlisten
        else unlisten()
      })
      // Without the listener only the reopen button is missing, the terminal itself still works.
      .catch(() => undefined)
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    async function drainInput(): Promise<void> {
      if (drainingInput || !active) return

      const session = sessionRef.current
      if (session === null) return

      drainingInput = true
      try {
        while (active && pendingInput.length > 0) {
          const data = pendingInput.shift()!
          pendingInputBytes -= new TextEncoder().encode(data).byteLength
          await session.write(data)
        }
      } catch (error) {
        if (active) {
          setStatus("error")
          setMessage(error instanceof Error ? error.message : String(error))
        }
      } finally {
        drainingInput = false
      }
    }
    const inputDisposable = terminal.onData((data) => {
      if (!active) return

      const dataBytes = new TextEncoder().encode(data).byteLength
      if (pendingInputBytes + dataBytes > MAX_QUEUED_INPUT_BYTES) {
        setStatus("error")
        setMessage(`Terminal input queue is full. Restart ${label} to continue.`)
        return
      }

      pendingInput.push(data)
      pendingInputBytes += dataBytes
      void drainInput()
    })

    stopRequestedRef.current = false
    setStatus("starting")
    setMessage(null)
    void startCodexTerminal(
      {
        sessionId,
        provider,
        repositoryPath,
        initialPrompt,
        model,
        context: contextRef.current,
        ...initialSize,
      },
      {
        onOutput(output) {
          if (active) terminal.write(new Uint8Array(output.data))
        },
        onExit(exit) {
          if (!active || activeSessionIdRef.current !== exit.sessionId) return

          exited = true
          sessionRef.current = null
          onSessionEnded(sessionId)
          setStatus("stopped")
          // The native report for our own Stop is a kill signal, which reads like a crash.
          const exitReport =
            exit.error ?? `${label} exited${exit.code === null ? "" : ` (${exit.code})`}.`
          setMessage(stopRequestedRef.current ? "Stopped." : exitReport)
        },
      }
    )
      .then((startedSession) => {
        if (!active || exited) {
          void (exited
            ? startedSession.dispose()
            : startedSession.stop().finally(startedSession.dispose))
          return
        }

        session = startedSession
        sessionRef.current = session
        onSessionStarted(sessionId)
        void session.updateContext(contextRef.current).catch((error: unknown) => {
          if (active) {
            setStatus("error")
            setMessage(error instanceof Error ? error.message : String(error))
          }
        })
        setStatus("running")
        void drainInput()
      })
      .catch((error: unknown) => {
        if (!active) return

        setStatus("error")
        setMessage(error instanceof Error ? error.message : String(error))
      })

    let session: CodexTerminalSession | null = null
    return () => {
      active = false
      pendingInput = []
      pendingInputBytes = 0
      inputDisposable.dispose()
      answerUnlisten?.()
      resizeObserver.disconnect()
      if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null
      onSessionEnded(sessionId)
      if (sessionRef.current === session) sessionRef.current = null
      if (session) void session.stop().finally(session.dispose)
      if (terminalRef.current === terminal) terminalRef.current = null
      terminal.dispose()
    }
  }, [
    label,
    model,
    onSessionEnded,
    onSessionStarted,
    provider,
    repositoryPath,
    launchKey,
    terminalIdentity,
  ])

  useEffect(() => {
    const session = sessionRef.current
    if (session === null) return

    void session.updateContext(context).catch((error: unknown) => {
      setStatus("error")
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }, [context])

  // paste() rather than a session write: xterm adds bracketed-paste markers when the CLI enabled
  // them, so the multi-line prompt lands in the input box instead of each newline submitting.
  function launch(): void {
    setLaunchKey((key) => key + 1)
  }

  function prefillPrompt(shortcut: TerminalPromptShortcut): void {
    const prompt = shortcut.buildPrompt({
      prUrl: `https://github.com/${context.owner}/${context.repo}/pull/${context.number}`,
      title: context.title,
      baseSha: context.baseSha,
      headSha: context.headSha,
      selectedFile: context.selectedFilePath,
    })
    terminalRef.current?.paste(prompt)
    terminalRef.current?.focus()
  }

  function reopenAnswer(): void {
    const sessionId = activeSessionIdRef.current
    if (sessionId === null) return

    void showAnswerWindow(sessionId).catch((error: unknown) => {
      setStatus("error")
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <section className={styles.terminalSection} aria-label={`${label} terminal`}>
      <div className={styles.terminalHeader}>
        <span className={styles.terminalTitle}>
          {status === "starting" ? `Starting ${label}…` : `${label} terminal`}
        </span>
        <div className={styles.terminalControls}>
          {hasAnswer && (
            <button type="button" className={styles.terminalAction} onClick={reopenAnswer}>
              Open answer
            </button>
          )}
          {(status === "stopped" || status === "error") && (
            <button type="button" className={styles.terminalAction} onClick={launch}>
              Restart
            </button>
          )}
          {status === "idle" && (
            <button type="button" className={styles.terminalAction} onClick={launch}>
              Start
            </button>
          )}
          {status === "running" && (
            <button
              type="button"
              className={styles.terminalAction}
              onClick={() => {
                stopRequestedRef.current = true
                void sessionRef.current?.stop().catch((error: unknown) => {
                  stopRequestedRef.current = false
                  setStatus("error")
                  setMessage(error instanceof Error ? error.message : String(error))
                })
              }}
            >
              Stop
            </button>
          )}
        </div>
      </div>
      {shortcuts.length > 0 && (
        <div className={styles.terminalShortcuts} role="group" aria-label="Prompt shortcuts">
          <span className={styles.terminalShortcutsCaption} aria-hidden="true">
            Prompts
          </span>
          {shortcuts.map((shortcut) => (
            <button
              key={shortcut.id}
              type="button"
              className={`${styles.terminalAction} ${styles.terminalChip}`}
              disabled={status !== "running"}
              title="Prefill the prompt, then press Enter"
              onClick={() => prefillPrompt(shortcut)}
            >
              {shortcut.label}
            </button>
          ))}
        </div>
      )}
      {message && (
        <p className={styles.terminalMessage} role={status === "error" ? "alert" : "status"}>
          {message}
        </p>
      )}
      <div className={styles.terminalHost} ref={hostRef} />
    </section>
  )
}
