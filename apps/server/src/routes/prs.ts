import type { FastifyInstance } from "fastify"
import { z } from "zod"

import {
  type AppContext,
  badRequest,
  parse,
  prParamsSchema,
  requireUser,
  toTarget,
} from "./context.js"

// PR data routes (docs/architecture.md §9). The SPA never talks to api.github.com —
// every GitHub call goes through the gateway here, where the token lives.

const analysisQuerySchema = z.object({
  engine: z.enum(["fast", "deep"]).default("fast"),
})

const fileQuerySchema = z.object({
  sha: z.string().optional(),
})

export function registerPrRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/prs/:owner/:repo/:number — PR meta.
  app.get("/api/prs/:owner/:repo/:number", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const { pr } = await ctx.gateway.getPullRequest(toTarget(params.value))
    return reply.send(pr)
  })

  // GET .../analysis?engine=fast — 202 {status:'analyzing'} while running, then the
  // AnalysisResult. The SPA polls (TanStack Query refetchInterval) until it flips.
  app.get("/api/prs/:owner/:repo/:number/analysis", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const query = parse(analysisQuerySchema, req.query)
    if (!query.ok) return badRequest(reply, query.issues)

    // Deep engine (§6) is a later slice — only the interface exists today.
    if (query.value.engine === "deep") {
      return reply.code(501).send({ error: "deep_engine_not_implemented" })
    }

    const state = ctx.analysis.request(toTarget(params.value))
    if (state.status === "analyzing") return reply.code(202).send({ status: "analyzing" })

    return reply.send(state.result)
  })

  // GET .../files/*?sha= — raw file content for the diff renderer (base or head).
  app.get("/api/prs/:owner/:repo/:number/files/*", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const query = parse(fileQuerySchema, req.query)
    if (!query.ok) return badRequest(reply, query.issues)

    const path = (req.params as Record<string, string>)["*"]
    if (!path) return reply.code(400).send({ error: "missing_file_path" })

    const target = toTarget(params.value)
    // Default to the head version when no SHA is given (the common diff-right side).
    const { pr, files } = await ctx.gateway.getPullRequest(target)
    const sha = query.value.sha ?? pr.headSha

    const content = await ctx.gateway.getFileContent(target, path, sha)
    // Changed files also carry their unified-diff patch — the diff renderer's input.
    const patch = files.find((f) => f.path === path)?.patch ?? null
    return reply.send({ path, sha, content, patch })
  })
}
