// The auth service, reduced to one shell command (docs/tauri-architecture.md §5, §7): borrow
// the token GitHub's own CLI already stores. This module is the narrow wrapper over the Tauri
// Shell plugin — app code depends on `fetchGhToken`, never on `Command`. The plugin is loaded
// through a lazy dynamic import so it stays in its own chunk, out of the web/http entry bundle.

// The token never touches the Store, a URL, or a log — it lives in webview memory only (§7).
export type GhTokenResult =
  { ok: true; token: string } | { ok: false; error: "gh-missing" | "gh-not-authed" }

type ShellOutput = { code: number | null; stdout: string; stderr: string }

async function runGhAuthToken(): Promise<ShellOutput> {
  const { Command } = await import("@tauri-apps/plugin-shell")

  // Scoped to exactly `gh auth token` in capabilities/default.json (§7) — the webview cannot
  // run any other command even if compromised. The args must match the pinned scope exactly.
  return Command.create("gh-auth-token", ["auth", "token"]).execute()
}

export async function fetchGhToken(): Promise<GhTokenResult> {
  let result: ShellOutput
  try {
    result = await runGhAuthToken()
  } catch {
    // A failed spawn (or a missing plugin) means the `gh` binary is not on PATH.
    return { ok: false, error: "gh-missing" }
  }

  const token = result.stdout.trim()
  if (result.code !== 0 || token.length === 0) {
    // gh is installed but not signed in: non-zero exit / empty token.
    return { ok: false, error: "gh-not-authed" }
  }

  return { ok: true, token }
}
