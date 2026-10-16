import {
  fileHistorySchema,
  prCommitListSchema,
  prOverviewSchema,
  rangeDiffSchema,
  reviewCommentSchema,
} from "@pr-visulizer/shared"
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

const reviewCommentListSchema = z.array(reviewCommentSchema)

const fileQuerySchema = z.object({
  sha: z.string().optional(),
})

// The two ends of a commit range, as the SPA sends them (§10). Both are required: a compare
// with a missing side is a bug, not a defaultable request.
const compareQuerySchema = z.object({
  base: z.string().min(1),
  head: z.string().min(1),
})

export function registerPrRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/prs/:owner/:repo/:number — the PR overview: meta + changed-file list, the
  // instant-open payload the SPA renders the shell from before analysis lands (§9). The
  // gateway already fetches both; we strip each file's patch (the diff renderer fetches it
  // per file) and validate against the shared contract before sending.
  app.get("/api/prs/:owner/:repo/:number", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const { pr, files } = await ctx.gateway.getPullRequest(toTarget(params.value))
    const overview = prOverviewSchema.parse({
      pr,
      files: files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        language: file.language,
      })),
    })
    return reply.send(overview)
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

  // POST .../refresh — drop what the BFF has cached about this PR, so the SPA's refresh button
  // re-reads the PR at its CURRENT head. Only the analysis job needs dropping: every other route
  // here calls the gateway per request. No body, no result — the SPA refetches its queries next.
  app.post("/api/prs/:owner/:repo/:number/refresh", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    ctx.analysis.forget(toTarget(params.value))
    return reply.code(204).send()
  })

  // GET .../commits — the PR's commits, for the diff pane's commit-range picker (§10). Read-only
  // and whole-PR; the range it produces narrows the DIFF only, never the ranking or the queue.
  app.get("/api/prs/:owner/:repo/:number/commits", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const commits = await ctx.gateway.listPrCommits(toTarget(params.value))
    return reply.send(prCommitListSchema.parse(commits))
  })

  // GET .../comments — every EXISTING published review comment on the PR (any author), for the
  // "show existing comments" feature. Read-only and whole-PR; the SPA groups them into threads
  // and anchors each to its head line. A sibling of the POST /comments in review.ts (same path,
  // different method): that one WRITES one comment, this one READS them all.
  app.get("/api/prs/:owner/:repo/:number/comments", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const comments = await ctx.gateway.listReviewComments(toTarget(params.value))
    return reply.send(reviewCommentListSchema.parse(comments))
  })

  // GET .../compare?base=&head= — the diff restricted to one commit range (§10). `base` is the
  // EXCLUSIVE boundary the SPA derived from the first selected commit's first parent; the
  // gateway turns the pair into GitHub's three-dot compare.
  app.get("/api/prs/:owner/:repo/:number/compare", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const query = parse(compareQuerySchema, req.query)
    if (!query.ok) return badRequest(reply, query.issues)

    const diff = await ctx.gateway.compareRange(
      toTarget(params.value),
      query.value.base,
      query.value.head
    )
    return reply.send(rangeDiffSchema.parse(diff))
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

  // GET .../history/* — the PR commits that touched one file, oldest-first, for the diff pane's
  // file history lens (§10). The splat is the path, the same way `/files/*` takes it.
  app.get("/api/prs/:owner/:repo/:number/history/*", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const path = (req.params as Record<string, string>)["*"]
    if (!path) return reply.code(400).send({ error: "missing_file_path" })

    const history = await ctx.gateway.listPrCommitsForPath(toTarget(params.value), path)
    return reply.send(fileHistorySchema.parse(history))
  })
}
