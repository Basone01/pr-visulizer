import type { LibSource } from "@pr-visulizer/engine/browser"

// The WEBVIEW platform's TYPE-LIBRARY loader — the LibSource twin of createBrowserGrammarSource
// (docs/tauri-architecture.md §3 seam 3). The deep-v2 precision tier needs TypeScript's
// `lib.*.d.ts` text; the engine stays platform-neutral and takes this seam.
//
// Why `?raw` and not the grammars' `?url` + fetch: a `.d.ts` is SOURCE, not a binary asset.
// Vite runs it through the TS transform, which erases a types-only file to an empty module —
// so fetching the emitted URL yields ZERO bytes and the compiler silently runs lib-less
// (measured: 0 bytes over `?url`, 527,611 bytes over `?raw`). Binary wasm has no such problem.
//
// `import.meta.glob` is NOT eager: each lib is its own lazily-imported chunk, so the ~2.35 MB
// of `.d.ts` text only loads when the tier actually runs.
const LIB_TEXT_LOADERS = import.meta.glob("/node_modules/typescript/lib/lib.*.d.ts", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>

export function libAssetCount(): number {
  return Object.keys(LIB_TEXT_LOADERS).length
}

export function createBrowserLibSource(): LibSource {
  return async (libName) => {
    const load = LIB_TEXT_LOADERS[`/node_modules/typescript/lib/${libName}`]
    if (!load) return undefined

    return load()
  }
}
