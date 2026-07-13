// Import the parser seam from the narrow `/parser` subpath, not the barrel: the barrel
// re-exports the node-coupled fast engine (its path utils import `node:path`), and Vite
// would try to bundle that into the browser build. The seam entry is web-tree-sitter only.
import { CORE_GRAMMAR_ID, type GrammarSource } from "@pr-visulizer/engine/parser"
import goWasmUrl from "tree-sitter-wasms/out/tree-sitter-go.wasm?url"
import javascriptWasmUrl from "tree-sitter-wasms/out/tree-sitter-javascript.wasm?url"
import tsxWasmUrl from "tree-sitter-wasms/out/tree-sitter-tsx.wasm?url"
import typescriptWasmUrl from "tree-sitter-wasms/out/tree-sitter-typescript.wasm?url"
// The WEBVIEW platform's wasm loader (docs/tauri-architecture.md §3 seam 3). The engine
// is platform-neutral and takes a `GrammarSource`; the node BFF reads the wasm off disk,
// this browser build fetches it. Each wasm file is pulled in as a Vite asset via a
// `?url` import, so the bundler emits it (hashed) into dist and hands back a runtime
// URL — no filesystem, no `createRequire`, which is exactly why the seam exists.
//
// web-tree-sitter's OWN core runtime wasm is bundled the same way and served under the
// reserved `CORE_GRAMMAR_ID`, so both the core and the grammars come from the platform.
import coreWasmUrl from "web-tree-sitter/tree-sitter.wasm?url"

// The bundled asset URL per grammar id. This map MUST cover every id `languageForPath` can
// return: a missing entry throws below, and the deep pipeline has no per-file catch, so ONE
// unbundled source file fails the whole analysis in the app while node tests stay green (the
// node loader resolves grammars off disk and never notices). `grammarSource.parity.test.ts`
// pins the coverage against the engine's SUPPORTED_GRAMMAR_IDS so this cannot drift again.
export const BUNDLED_WASM_URLS: Readonly<Record<string, string>> = {
  [CORE_GRAMMAR_ID]: coreWasmUrl,
  typescript: typescriptWasmUrl,
  tsx: tsxWasmUrl,
  javascript: javascriptWasmUrl,
  go: goWasmUrl,
}

export function createBrowserGrammarSource(): GrammarSource {
  return async (grammarId) => {
    const url = BUNDLED_WASM_URLS[grammarId]
    if (!url) throw new Error(`No bundled wasm asset for grammar "${grammarId}"`)

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch grammar wasm "${grammarId}": ${response.status}`)
    }

    return new Uint8Array(await response.arrayBuffer())
  }
}
