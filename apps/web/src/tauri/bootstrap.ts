import { resolvePrecisionPolicy } from "@pr-visulizer/engine"

import { DESKTOP_PRECISION_PRESET } from "@/config/settings"

import { parsePrTarget } from "@/utils/prUrl/parsePrTarget"
import { writePrefillToUrl, writeTargetToUrl } from "@/utils/prUrl/targetUrl"
import { createTauriKeyValueStore } from "@/utils/storage/keyValueStore"

import { OPEN_TARGET_EVENT } from "@/entity/deepLink"

import { initTauriClient } from "@/service/clientFactory"

import { onSecondInstance, readCliUrlArg, targetFromForwardedArgv } from "./cliArgs"
import { fetchGhToken } from "./ghToken"
import { loadTauriFetch } from "./tauriHttp"

// The desktop startup flow (docs/tauri-architecture.md §5), all of it: run `gh auth token`
// once, wire the Tauri PrClient (token + CORS-free fetch + Store), turn a cold-start CLI arg
// into a deep link, and forward a second invocation's URL to the running window. Everything
// Tauri-specific reaches this file only through the lazy wrappers around it, so it — and the
// plugin chunks — never load in web/http mode.
export type TauriBootResult = { ok: true } | { ok: false; error: "gh-missing" | "gh-not-authed" }

// A cold-start URL initializes the review screen through the URL params App reads at mount;
// an unparseable arg prefills the home input instead (§5 error table).
function applyColdStartArg(raw: string | null): void {
  if (!raw) return

  const target = parsePrTarget(raw)
  if (target) {
    writeTargetToUrl(target)
    return
  }

  writePrefillToUrl(raw)
}

export async function bootstrapTauri(): Promise<TauriBootResult> {
  const tokenResult = await fetchGhToken()
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error }

  const fetch = await loadTauriFetch()
  initTauriClient({
    token: tokenResult.token,
    fetch,
    storage: createTauriKeyValueStore(),
    precision: resolvePrecisionPolicy(DESKTOP_PRECISION_PRESET),
  })

  applyColdStartArg(await readCliUrlArg())

  // A second `pr-visualizer <url>` forwards its argv here; the window is already open, so
  // navigate it through the same event App listens for rather than the URL initializer.
  await onSecondInstance((argv) => {
    const target = targetFromForwardedArgv(argv)
    if (target) window.dispatchEvent(new CustomEvent(OPEN_TARGET_EVENT, { detail: target }))
  })

  return { ok: true }
}
