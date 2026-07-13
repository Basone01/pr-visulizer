import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

import { CORE_GRAMMAR_ID, type GrammarSource } from "./treeSitter.js"

// The NODE platform's wasm loader (§3 seam) — the only node-coupled code in the engine,
// so it lives behind the `@pr-visulizer/engine/node` entry and the browser entry never
// touches `node:module`/`node:fs`. It resolves the prebuilt binaries from the installed
// packages and reads their bytes: web-tree-sitter's core wasm for `CORE_GRAMMAR_ID`, and
// tree-sitter-wasms' grammar binary for a language id (building from source needs
// emscripten — not available offline).

const requireFromHere = createRequire(import.meta.url)

function wasmPathFor(grammarId: string): string {
  if (grammarId === CORE_GRAMMAR_ID) {
    return requireFromHere.resolve("web-tree-sitter/tree-sitter.wasm")
  }

  return requireFromHere.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarId}.wasm`)
}

export function createNodeGrammarSource(): GrammarSource {
  return async (grammarId) => readFile(wasmPathFor(grammarId))
}

// The NODE platform's type-library loader — the LibSource twin of createNodeGrammarSource.
// The webview supplies its own (Vite `?raw` assets); node reads the files typescript ships.
export function createNodeLibSource(): (libName: string) => Promise<string | undefined> {
  return async (libName) => {
    try {
      const libPath = requireFromHere.resolve(`typescript/lib/${libName}`)
      return await readFile(libPath, "utf8")
    } catch {
      return undefined
    }
  }
}
