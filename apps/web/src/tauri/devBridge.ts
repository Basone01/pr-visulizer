// Dev-only bridge that lets the tauri-webview MCP server drive this WKWebView (which has no
// CDP endpoint, so no external tool can drive it directly). It polls a local command bus for
// {eval, click, text, wait} commands, runs them in-page, and posts back the result. Loaded
// only in a dev build under Tauri (see main.tsx); it never ships in a release bundle.
//
// Canonical template + the MCP server live in dot-ai/tools/tauri-webview-mcp/ (shared across
// projects). This is the app-local copy; keep it in sync with that template.
const BRIDGE_URL = "http://127.0.0.1:7331"

type Command =
  | { id: number; cmd: "eval"; expression: string }
  | { id: number; cmd: "click"; selector: string }
  | { id: number; cmd: "text"; max: number }
  | { id: number; cmd: "wait"; expression: string; timeoutMs: number }

async function runCommand(command: Command): Promise<unknown> {
  switch (command.cmd) {
    case "eval":
      // Indirect eval; the MCP caller is a trusted local dev tool.
      return await (0, eval)(`(async () => (${command.expression}))()`)
    case "click": {
      const el = document.querySelector<HTMLElement>(command.selector)
      if (!el) return false
      el.click()
      return true
    }
    case "text":
      return document.body.innerText.slice(0, command.max)
    case "wait": {
      const deadline = Date.now() + command.timeoutMs
      while (Date.now() < deadline) {
        try {
          if (await (0, eval)(`(async () => (${command.expression}))()`)) return true
        } catch {
          /* keep polling */
        }
        await new Promise((r) => setTimeout(r, 120))
      }
      return false
    }
  }
}

async function pollOnce(): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/poll`, { cache: "no-store" })
  const commands = (await res.json()) as Command[]

  for (const command of commands) {
    try {
      const result = await runCommand(command)
      void fetch(`${BRIDGE_URL}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: command.id, result }),
      })
    } catch (error) {
      void fetch(`${BRIDGE_URL}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: command.id, error: String(error) }),
      })
    }
  }
}

export function startDevBridge(): void {
  let running = true
  const loop = async (): Promise<void> => {
    while (running) {
      try {
        await pollOnce()
        await new Promise((r) => setTimeout(r, 100))
      } catch {
        // Server not up yet (or stopped) — back off and keep trying so it reconnects
        // whenever the MCP server starts.
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
  void loop()
  window.addEventListener("beforeunload", () => {
    running = false
  })

  // eslint-disable-next-line no-console
  console.info("[dev-bridge] polling", BRIDGE_URL)
}
