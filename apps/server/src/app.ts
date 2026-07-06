import cookie from "@fastify/cookie"
import Fastify, { type FastifyInstance } from "fastify"

import type { Env } from "./config/env.js"
import { type AppContext, registerRoutes } from "./routes/index.js"
import { createAnalysisService, createFastAstEngine } from "./services/analysis/index.js"
import {
  type GatewayFixture,
  type GithubGateway,
  createFakeGithubGateway,
  createOctokitGateway,
} from "./services/githubGateway/index.js"
import { type ProgressStore, createProgressStore } from "./services/progressStore/index.js"
import { createReviewSubmitService } from "./services/reviewSubmit/index.js"

// The composition root (node conventions): the one place dependencies are wired.
// Every override is optional so tests can inject a fake gateway / in-memory store.
export type BuildAppOptions = {
  env: Env
  gateway?: GithubGateway
  fixtures?: GatewayFixture[]
  progress?: ProgressStore
}

function resolveGateway(env: Env, options: BuildAppOptions): GithubGateway {
  if (options.gateway) return options.gateway
  if (env.GITHUB_FAKE) return createFakeGithubGateway(options.fixtures)

  // Real gateway (§2): a dev PAT is accepted; full per-user OAuth vault is a later slice.
  return createOctokitGateway(env.GITHUB_TOKEN ?? "")
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { env } = options

  const gateway = resolveGateway(env, options)
  const engine = createFastAstEngine({ gateway })
  const analysis = createAnalysisService(engine)
  const progress = options.progress ?? createProgressStore(env.DATABASE_URL)
  const review = createReviewSubmitService(gateway)

  // Local-dev bypass identity: DEV_USER, or a default when booting the fake gateway.
  const devUserId = env.DEV_USER ?? (env.GITHUB_FAKE ? "dev-user" : undefined)

  const ctx: AppContext = { env, devUserId, gateway, analysis, progress, review }

  const app = Fastify({ logger: false })
  // httpOnly session cookie signing (§12).
  app.register(cookie, { secret: env.SESSION_SECRET })
  app.addHook("onClose", async () => {
    progress.close()
  })

  registerRoutes(app, ctx)
  return app
}
