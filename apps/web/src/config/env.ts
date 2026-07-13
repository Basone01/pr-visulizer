import { z } from "zod"

// The browser env is a boundary like any other — parse it, don't trust it.
// Vite only exposes VITE_-prefixed vars to the client; that prefix IS the
// server/client boundary, so no server secret can leak here.
const envSchema = z.object({
  // "1" turns on fixture mode: the PR #42 analysis is served client-side so the
  // SPA renders end-to-end without the BFF (docs/architecture.md verify note).
  fixture: z
    .string()
    .optional()
    .transform((value) => value === "1"),

  // "1" forces tauri mode in a plain browser (for dev/testing the TauriPrClient without
  // packaging). In the real desktop shell the webview injects `window.__TAURI_INTERNALS__`,
  // so mode is detected at runtime and this flag is only the manual dev override.
  tauri: z
    .string()
    .optional()
    .transform((value) => value === "1"),
})

const parsed = envSchema.parse({
  fixture: import.meta.env.VITE_FIXTURE,
  tauri: import.meta.env.VITE_TAURI,
})

// Tauri mode: the desktop webview (which injects `__TAURI_INTERNALS__`), or the manual
// VITE_TAURI dev override. Runtime detection is the primary signal so the SAME build boots
// as a desktop app or a plain web page depending on where it runs.
function detectTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export const env = {
  fixtureMode: parsed.fixture,
  tauriMode: parsed.tauri || detectTauriRuntime(),
} as const
