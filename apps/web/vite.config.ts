import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

// The SPA never talks to api.github.com — every call goes to the BFF (§9), so the
// dev server proxies /api to the Fastify BFF. The server slice is built
// concurrently; its port is assumed 3001 until confirmed.
const BFF_PORT = 3001

export default defineConfig({
  plugins: [react()],
  build: {
    // vite's build-import-analysis pass re-parses every emitted chunk; on the MINIFIED bundle
    // it throws "Parse error @:1:1" — a rollup parseAst limitation triggered by both esbuild
    // and terser output (unminified parses fine). Disabling minification is the reliable
    // work-around. The desktop webview loads chunks from local disk, so bundle size costs it
    // nothing; the browser (BFF-served) build ships larger until this is root-caused upstream.
    minify: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // react-lang auto-mounts @openuidev/devtools in development, and that package imports its
      // UI from cdn.jsdelivr.net at runtime. Remote JavaScript must never load into the Tauri
      // webview, so the package is replaced by a stub that renders nothing.
      "@openuidev/devtools": fileURLToPath(
        new URL("./src/utils/openuiDevtoolsStub.ts", import.meta.url)
      ),
    },
  },
  worker: {
    // The analysis worker's module graph code-splits, which the default iife worker format
    // cannot express — ES modules are the only splitting-capable worker format.
    format: "es",
  },
  server: {
    // Tauri's devUrl is hardcoded to 5173 (apps/desktop tauri.conf.json). Without
    // strictPort, a busy 5173 makes vite silently shift to 5174 and the desktop
    // webview loads a dead port — a pure white window. Fail loudly instead.
    port: 5173,
    strictPort: true,
    // Pin IPv4: the default "localhost" can bind ::1 only (Node resolution order), and the
    // desktop webview loads devUrl over IPv4 — another silent white window. Browsers fall
    // back to 127.0.0.1 on their own, so the web path loses nothing.
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://localhost:${BFF_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
