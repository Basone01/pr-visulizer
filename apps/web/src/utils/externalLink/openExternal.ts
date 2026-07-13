import { env } from "@/config/env"

// One wrapper for "open a URL outside the app" (external-library rule): the plain browser uses
// window.open; the Tauri desktop shell uses the official opener plugin, imported lazily so the
// plugin module never loads (nor is bundled into the critical path) in a web build. Call sites
// depend on THIS function, not on @tauri-apps/plugin-opener — so the mechanism swaps in one place.
export async function openExternalUrl(url: string): Promise<void> {
  if (env.tauriMode) {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    await openUrl(url)
    return
  }

  window.open(url, "_blank", "noopener,noreferrer")
}
