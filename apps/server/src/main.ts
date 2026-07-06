import type { FastifyInstance } from "fastify"

import { buildApp } from "./app.js"
import { loadEnv } from "./config/env.js"

// Boot entry. Env is parsed-and-validated first (fail fast), then the app is wired
// and starts listening. Graceful shutdown drains in-flight requests on a signal.

function installGracefulShutdown(app: FastifyInstance): void {
  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true

    // Armed failsafe: if draining hangs, force-exit rather than wedge forever.
    const forceKill = setTimeout(() => process.exit(1), 10_000)
    forceKill.unref()

    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`Error during ${signal} shutdown:`, error)
        process.exit(1)
      })
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

async function main(): Promise<void> {
  const env = loadEnv()
  const app = buildApp({ env })

  installGracefulShutdown(app)

  const address = await app.listen({ port: env.PORT, host: env.HOST })
  console.log(`pr-visulizer BFF listening on ${address} (fake gateway: ${env.GITHUB_FAKE})`)
}

main().catch((error: unknown) => {
  console.error("Failed to start server:", error)
  process.exit(1)
})
