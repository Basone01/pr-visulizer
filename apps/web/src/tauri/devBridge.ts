// Copy into the frontend and load only behind import.meta.env.DEV and a Tauri check.
const BRIDGE_URL = "http://127.0.0.1:7331"
const MAX_QUEUED = 256

type Command = { id: string; expiresAt: number } & (
  | { cmd: "eval"; expression: string }
  | { cmd: "click"; selector: string }
  | { cmd: "text"; max: number }
  | { cmd: "wait"; expression: string; timeoutMs: number }
)

function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object") return false

  const command = value as Record<string, unknown>
  if (
    typeof command.id !== "string" ||
    typeof command.expiresAt !== "number" ||
    !Number.isFinite(command.expiresAt)
  )
    return false

  switch (command.cmd) {
    case "eval":
      return typeof command.expression === "string"
    case "click":
      return typeof command.selector === "string"
    case "text":
      return (
        typeof command.max === "number" &&
        Number.isInteger(command.max) &&
        command.max >= 0 &&
        command.max <= 100000
      )
    case "wait":
      return (
        typeof command.expression === "string" &&
        typeof command.timeoutMs === "number" &&
        Number.isInteger(command.timeoutMs) &&
        command.timeoutMs >= 0 &&
        command.timeoutMs <= 60000
      )
    default:
      return false
  }
}

async function runCommand(command: Command, running: () => boolean): Promise<unknown> {
  switch (command.cmd) {
    case "eval":
      // Indirect eval runs in the webview's global scope, for trusted local dev callers.
      return await (0, eval)(`(async () => (${command.expression}))()`)
    case "click": {
      const element = document.querySelector<HTMLElement>(command.selector)
      if (!element) return false

      element.click()
      return true
    }
    case "text":
      return document.body.innerText.slice(0, command.max)
    case "wait": {
      const deadline = Math.min(command.expiresAt, Date.now() + command.timeoutMs)
      while (running() && Date.now() < deadline) {
        try {
          if (await (0, eval)(`(async () => (${command.expression}))()`)) return true
        } catch {
          /* The condition may become valid on a later poll. */
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return false
    }
  }
}

let stopCurrent: (() => void) | undefined

export function startDevBridge(): () => void {
  stopCurrent?.()
  const appId = crypto.randomUUID()
  const controller = new AbortController()
  const queue: Command[] = []
  let running = true
  let executing = false

  const stop = (): void => {
    running = false
    queue.length = 0
    controller.abort()
    window.removeEventListener("beforeunload", stop)
    if (stopCurrent === stop) stopCurrent = undefined
  }
  stopCurrent = stop
  window.addEventListener("beforeunload", stop)

  const postResult = async (body: {
    id: string
    result?: unknown
    error?: string
  }): Promise<void> => {
    if (!running) return

    let serialized: string
    try {
      serialized = JSON.stringify({ appId, ...body })
      if (new TextEncoder().encode(serialized).length > 1024 * 1024) {
        throw new Error("Result exceeds 1 MiB")
      }
    } catch (error) {
      serialized = JSON.stringify({
        appId,
        id: body.id,
        error: `Result serialization failed: ${String(error)}`,
      })
    }

    try {
      const response = await fetch(`${BRIDGE_URL}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serialized,
        signal: controller.signal,
      })
      if (!response.ok && response.status !== 409) {
        // Report rejection without executing the command a second time.
        await fetch(`${BRIDGE_URL}/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId,
            id: body.id,
            error: `Result rejected: HTTP ${response.status}`,
          }),
          signal: controller.signal,
        })
      }
    } catch {
      /* Never replay commands when a result cannot be delivered. */
    }
  }

  const executeBeforeExpiry = async (command: Command): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Command expired during execution")),
        Math.max(0, command.expiresAt - Date.now())
      )
      abort = () => reject(new Error("Bridge stopped"))
      controller.signal.addEventListener("abort", abort, { once: true })
    })
    try {
      // A timed-out promise cannot block later commands. Already-started JS cannot be undone.
      return await Promise.race([runCommand(command, () => running), expiry])
    } finally {
      clearTimeout(timer)
      if (abort) controller.signal.removeEventListener("abort", abort)
    }
  }

  const drain = async (): Promise<void> => {
    if (executing) return

    executing = true
    try {
      while (running && queue.length) {
        const command = queue.shift()
        if (!command || command.expiresAt <= Date.now()) continue

        try {
          const result = await executeBeforeExpiry(command)
          await postResult({ id: command.id, result })
        } catch (error) {
          await postResult({ id: command.id, error: String(error) })
        }
      }
    } finally {
      executing = false
    }
  }

  const loop = async (): Promise<void> => {
    while (running) {
      let delay = 100
      try {
        const query = new URLSearchParams({
          appId,
          name: document.title,
          url: location.origin + location.pathname,
        })
        const response = await fetch(`${BRIDGE_URL}/poll?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`)

        const commands: unknown = await response.json()
        if (!Array.isArray(commands) || !commands.every(isCommand))
          throw new Error("Invalid bridge commands")
        if (!running) return

        for (const command of commands) {
          if (queue.length >= MAX_QUEUED) {
            void postResult({
              id: command.id,
              error: "App command queue is full",
            })
            continue
          }
          queue.push(command)
        }
        void drain()
      } catch {
        delay = 1000
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  void loop()
  return stop
}

if (import.meta.hot) import.meta.hot.dispose(() => stopCurrent?.())
