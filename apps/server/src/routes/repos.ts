import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { type AppContext, badRequest, parse, requireUser } from "./context.js"

// Repo-level routes (docs/tauri-architecture.md §5). The home-screen PR picker is shared
// UI: browser mode reaches the open-PR list through THIS route, so the hosted deployment
// gains the picker for free while tauri mode calls the gateway directly. The SPA never
// talks to api.github.com — the token stays server-side, behind the gateway.

const repoParamsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
})

export function registerRepoRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/repos/:owner/:repo/pulls — open PRs, newest-updated first.
  app.get("/api/repos/:owner/:repo/pulls", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(repoParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const summaries = await ctx.gateway.listOpenPullRequests(params.value)
    return reply.send(summaries)
  })
}
