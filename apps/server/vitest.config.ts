import { defineConfig } from "vitest/config"

// Own runner for the BFF. The root workspace lists this project (Vitest 3.2+
// `test.projects`); `pnpm -r test` also drives it via the package test script.
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
