import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

// The SPA never talks to api.github.com — every call goes to the BFF (§9), so the
// dev server proxies /api to the Fastify BFF. The server slice is built
// concurrently; its port is assumed 3001 until confirmed.
const BFF_PORT = 3001

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${BFF_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
