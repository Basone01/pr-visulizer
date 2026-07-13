import { defineConfig } from "vitest/config"

// Own runner for the engine package. Real tree-sitter wasm grammars load off disk via the
// node GrammarSource, so these are node-environment tests (no jsdom). The root workspace
// lists this project (Vitest 3.2+ `test.projects`); `pnpm -r test` drives it via the
// package `test` script.
export default defineConfig({
  test: {
    name: "engine",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
