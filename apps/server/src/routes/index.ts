import type { FastifyInstance } from "fastify"

import { registerAuthRoutes } from "./auth.js"
import type { AppContext } from "./context.js"
import { registerProgressRoutes } from "./progress.js"
import { registerPrRoutes } from "./prs.js"
import { registerReviewRoutes } from "./review.js"

export type { AppContext } from "./context.js"

// Wire every §9 endpoint onto the instance. Called once from the composition root.
export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/health", async () => ({ status: "ok" }))

  registerAuthRoutes(app, ctx)
  registerPrRoutes(app, ctx)
  registerProgressRoutes(app, ctx)
  registerReviewRoutes(app, ctx)
}
