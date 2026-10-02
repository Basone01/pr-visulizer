import { z } from "zod"

const terminalOutputSchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  data: z.array(z.number().int().min(0).max(255)),
})

const terminalExitSchema = z.object({
  sessionId: z.string().min(1),
  code: z.number().int().nullable(),
  error: z.string().nullable(),
})

export type CodexTerminalStart = {
  sessionId: string
  repositoryPath: string
  initialPrompt: string
  model: string | null
  rows: number
  cols: number
  context: CodexTerminalContext
}

export type CodexTerminalContext = {
  owner: string
  repo: string
  number: number
  title: string
  baseSha: string
  headSha: string
  selectedFilePath: string | null
}

type TerminalOutput = z.infer<typeof terminalOutputSchema>
type TerminalExit = z.infer<typeof terminalExitSchema>

export type CodexTerminalSession = {
  write(data: string): Promise<void>
  resize(rows: number, cols: number): Promise<void>
  updateContext(context: CodexTerminalContext): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
  return tauriInvoke<T>(command, args)
}

// This is the only webview-facing terminal protocol. It parses untrusted Tauri event payloads
// before xterm sees them, leaving the terminal component free of IPC and schema details.
export async function startCodexTerminal(
  input: CodexTerminalStart,
  handlers: {
    onOutput: (output: TerminalOutput) => void
    onExit: (exit: TerminalExit) => void
  }
): Promise<CodexTerminalSession> {
  const { listen } = await import("@tauri-apps/api/event")
  const sessionId = input.sessionId
  let disposed = false
  let writeQueue = Promise.resolve()
  let contextUpdateQueue = Promise.resolve()
  let started = false
  let outputUnlisten = () => {}
  let exitUnlisten = () => {}

  try {
    outputUnlisten = await listen("codex-terminal://output", (event: { payload: unknown }) => {
      const output = terminalOutputSchema.safeParse(event.payload)
      if (output.success && output.data.sessionId === sessionId) handlers.onOutput(output.data)
    })
    exitUnlisten = await listen("codex-terminal://exit", (event: { payload: unknown }) => {
      const exit = terminalExitSchema.safeParse(event.payload)
      if (exit.success && exit.data.sessionId === sessionId) handlers.onExit(exit.data)
    })
    await invoke("codex_terminal_start", { request: input })
    started = true
    await invoke("codex_terminal_attach", { request: { sessionId } })
  } catch (error) {
    if (started) {
      await invoke("codex_terminal_stop", { request: { sessionId } }).catch(() => undefined)
    }
    outputUnlisten()
    exitUnlisten()
    throw error
  }

  async function dispose(): Promise<void> {
    if (disposed) return

    disposed = true
    outputUnlisten()
    exitUnlisten()
  }

  return {
    write(data) {
      const write = async (): Promise<void> => {
        await invoke("codex_terminal_write", {
          request: {
            sessionId,
            data: Array.from(new TextEncoder().encode(data)),
          },
        })
      }
      const queuedWrite = writeQueue.catch(() => undefined).then(write)
      writeQueue = queuedWrite
      return queuedWrite
    },
    resize(rows, cols) {
      return invoke("codex_terminal_resize", { request: { sessionId, rows, cols } })
    },
    updateContext(context) {
      const update = async (): Promise<void> => {
        await invoke("codex_terminal_update_context", { request: { sessionId, context } })
      }
      const queuedUpdate = contextUpdateQueue.catch(() => undefined).then(update)
      contextUpdateQueue = queuedUpdate
      return queuedUpdate
    },
    stop() {
      return invoke("codex_terminal_stop", { request: { sessionId } })
    },
    dispose,
  }
}
