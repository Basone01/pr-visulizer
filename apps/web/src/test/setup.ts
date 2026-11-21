import "@testing-library/jest-dom/vitest"

// Newer Node versions (seen on Node 26) ship their own Web Storage globals, which read as
// undefined without `--localstorage-file`. Vitest copies a jsdom global onto globalThis only
// when Node lacks that name (or it is on Vitest's allow-list, which storage is not), so every
// test saw Node's empty storage instead of jsdom's. Point both names back at jsdom's storage.
function useJsdomStorage(): void {
  const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window
  // A test that opts into the node environment has no jsdom window, and nothing to restore.
  if (!jsdomWindow) return

  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: () => jsdomWindow[name],
    })
  }
}

useJsdomStorage()
