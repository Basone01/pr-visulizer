import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useEffect, useRef, useState } from "react"

import { env } from "@/config/env"

import {
  type CodexTerminalContext,
  type CodexTerminalSession,
  startCodexTerminal,
} from "@/service/terminal/codexTerminal"

import styles from "./AiReviewPanel.module.css"

type CodexTerminalProps = {
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
  repositoryPath,
  initialPrompt,
  model,
  terminalIdentity,
  onSessionStarted,
  onSessionEnded,
  context,
}: CodexTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<CodexTerminalSession | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<"starting" | "running" | "stopped" | "error">("starting")
  const [message, setMessage] = useState<string | null>(null)
  const [restartKey, setRestartKey] = useState(0)
  const contextRef = useRef(context)
  contextRef.current = context

  useEffect(() => {
    if (!env.tauriMode) {
      setStatus("error")
      setMessage("The Codex terminal is available in the desktop app.")
      return
    }
    if (repositoryPath === null) {
      setStatus("error")
      setMessage("Link this repository before starting Codex.")
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
        setMessage("Terminal input queue is full. Restart Codex to continue.")
        return
      }

      pendingInput.push(data)
      pendingInputBytes += dataBytes
      void drainInput()
    })

    setStatus("starting")
    setMessage(null)
    void startCodexTerminal(
      {
        sessionId,
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
          setMessage(exit.error ?? `Codex exited${exit.code === null ? "" : ` (${exit.code})`}.`)
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
      resizeObserver.disconnect()
      if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null
      onSessionEnded(sessionId)
      if (sessionRef.current === session) sessionRef.current = null
      if (session) void session.stop().finally(session.dispose)
      terminal.dispose()
    }
  }, [model, onSessionEnded, onSessionStarted, repositoryPath, restartKey, terminalIdentity])

  useEffect(() => {
    const session = sessionRef.current
    if (session === null) return

    void session.updateContext(context).catch((error: unknown) => {
      setStatus("error")
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }, [context])

  return (
    <section className={styles.terminalSection} aria-label="Codex terminal">
      <div className={styles.terminalHeader}>
        <span>{status === "starting" ? "Starting Codex…" : "Codex terminal"}</span>
        {(status === "stopped" || status === "error") && (
          <button
            type="button"
            className={styles.terminalAction}
            onClick={() => setRestartKey((key) => key + 1)}
          >
            Restart
          </button>
        )}
        {status === "running" && (
          <button
            type="button"
            className={styles.terminalAction}
            onClick={() => {
              void sessionRef.current?.stop().catch((error: unknown) => {
                setStatus("error")
                setMessage(error instanceof Error ? error.message : String(error))
              })
            }}
          >
            Stop
          </button>
        )}
      </div>
      {message && (
        <p className={styles.terminalMessage} role={status === "error" ? "alert" : "status"}>
          {message}
        </p>
      )}
      <div className={styles.terminalHost} ref={hostRef} />
    </section>
  )
}
