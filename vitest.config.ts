import { defineConfig } from "vitest/config"

// Workspace-level runner. Uses Vitest 3.2+ `test.projects` (the deprecated
// `vitest.workspace.ts` file is gone). Each project owns its own config.
export default defineConfig({
  test: {
    projects: ["packages/shared", "apps/server"],
  },
})
