import { env } from "@/config/env"

import { type KeyValueStore, createLocalStorageKeyValueStore } from "@/utils/storage/keyValueStore"

import { createFixturePrClient } from "./fixture/fixturePrClient"
import { createHttpPrClient } from "./http/httpPrClient"
import type { PrClient } from "./prClient"
import { type TauriPrClientDeps, createTauriPrClient } from "./tauri/tauriPrClient"

// One composition root for the data boundary. Fixture and http swap the whole client in
// one place — no call site changes (docs/architecture.md verify note). Tauri is the third
// implementation (docs/tauri-architecture.md §6): its deps (gh token, Tauri fetch, Store)
// only exist inside the desktop shell, so they are handed in through `initTauriClient`
// BEFORE React mounts, rather than constructed here.
let client: PrClient | null = null
let tauriDeps: TauriPrClientDeps | null = null

// The desktop bootstrap seam (docs/tauri-architecture.md §5 startup flow). The shell runs
// `gh auth token` once, wires the Tauri HTTP-plugin fetch and the Store, and calls this
// before mounting the app. In plain-browser dev the same call can inject a PAT + global
// fetch + a localStorage/in-memory store to exercise the tauri client without packaging.
export function initTauriClient(deps: TauriPrClientDeps): void {
  tauriDeps = deps
  client = null // let the next getPrClient() rebuild against the injected deps
}

function resolveClient(): PrClient {
  if (env.tauriMode) {
    if (!tauriDeps) {
      throw new Error("tauri mode: call initTauriClient(deps) before mounting the app")
    }

    return createTauriPrClient(tauriDeps)
  }

  if (env.fixtureMode) return createFixturePrClient()

  return createHttpPrClient()
}

export function getPrClient(): PrClient {
  if (client) return client

  client = resolveClient()
  return client
}

// The store the home screen persists its watched-repo list through (docs/tauri-
// architecture.md §5): the desktop shell's Tauri Store when injected, localStorage in the
// browser. Kept next to the client factory so both share the one injected Store instance.
export function getAppStorage(): KeyValueStore {
  return tauriDeps?.storage ?? createLocalStorageKeyValueStore()
}
