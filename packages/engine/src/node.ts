// The node-only entry (docs/tauri-architecture.md §3): the platform wasm loader that
// resolves grammars from disk. Kept out of the `.` entry so importing the engine in a
// webview never pulls in `node:module`/`node:fs`.

export {
  createNodeGrammarSource,
  createNodeLibSource,
} from "./services/analysis/nodeGrammarSource.js"
