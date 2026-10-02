// The one narrow key/value boundary the desktop client persists through (docs/tauri-
// architecture.md §5, §6). Call sites depend on THIS interface, never on the Tauri Store
// plugin directly, so the backing store is swappable in one place (external-lib wrapping
// rule): the Tauri Store in the desktop shell, localStorage in plain-browser dev, an
// in-memory map in tests. Values are opaque strings — callers own their own JSON + schema.
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// In-memory: no persistence, no platform — the store tests inject so the client is
// exercisable without Tauri or a DOM.
export function createMemoryKeyValueStore(): KeyValueStore {
  const entries = new Map<string, string>()

  return {
    async get(key) {
      return entries.get(key) ?? null
    },
    async set(key, value) {
      entries.set(key, value)
    },
    async delete(key) {
      entries.delete(key)
    },
  }
}

// Browser-dev fallback: the SPA's own localStorage, namespaced so keys never collide with
// anything else the origin stores.
export function createLocalStorageKeyValueStore(namespace = "prv"): KeyValueStore {
  const scopedKey = (key: string): string => `${namespace}:${key}`

  return {
    async get(key) {
      return window.localStorage.getItem(scopedKey(key))
    },
    async set(key, value) {
      window.localStorage.setItem(scopedKey(key), value)
    },
    async delete(key) {
      window.localStorage.removeItem(scopedKey(key))
    },
  }
}

// The narrow slice of @tauri-apps/plugin-store's Store this wrapper actually uses.
type TauriStore = {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

// The desktop implementation, backed by the Tauri Store plugin's local JSON file.
// The plugin is imported LAZILY through a literal dynamic import: Vite code-splits it into
// its own chunk, so the plain-web build never loads it (the chunk only runs in the desktop
// shell), yet the specifier still resolves at runtime in the packaged webview — which a bare
// `@vite-ignore` specifier would not. The store handle is created once and reused.
export function createTauriKeyValueStore(fileName = "prv-store.json"): KeyValueStore {
  let handle: Promise<TauriStore> | null = null

  const store = (): Promise<TauriStore> => {
    if (!handle) {
      handle = import("@tauri-apps/plugin-store").then(
        (plugin) => plugin.load(fileName) as Promise<TauriStore>
      )
    }

    return handle
  }

  return {
    async get(key) {
      const opened = await store()
      return (await opened.get<string>(key)) ?? null
    },
    async set(key, value) {
      const opened = await store()
      await opened.set(key, value)
      await opened.save()
    },
    async delete(key) {
      const opened = await store()
      await opened.delete(key)
      await opened.save()
    },
  }
}
