import { type ReviewProgress, reviewProgressSchema } from "@pr-visulizer/shared"
import type { FastifyInstance } from "fastify"

import {
  type AppContext,
  badRequest,
  parse,
  prParamsSchema,
  requireUser,
  toTarget,
} from "./context.js"

// Review-progress read/write (docs/architecture.md §9, §11). PUT is idempotent
// full-state replacement — the simplest possible checkmark/draft sync. Identity fields
// are taken from the path + session + PR head (never trusted from the body).

export function registerProgressRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/prs/:owner/:repo/:number/progress", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const target = toTarget(params.value)
    const { pr } = await ctx.gateway.getPullRequest(target)

    const existing = ctx.progress.get({
      userId: user.userId,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.number,
      headSha: pr.headSha,
    })

    // A never-reviewed PR returns a valid empty shape so the SPA always parses cleanly.
    const progress: ReviewProgress = existing ?? {
      userId: user.userId,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.number,
      headSha: pr.headSha,
      reviewedFiles: [],
      drafts: [],
    }

    return reply.send(progress)
  })

  app.put("/api/prs/:owner/:repo/:number/progress", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const body = parse(reviewProgressSchema, req.body)
    if (!body.ok) return badRequest(reply, body.issues)

    const target = toTarget(params.value)
    const { pr } = await ctx.gateway.getPullRequest(target)

    // Server-authoritative identity: only the reviewer's own state (files, drafts,
    // verdict) is taken from the body.
    const progress: ReviewProgress = {
      userId: user.userId,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.number,
      headSha: pr.headSha,
      reviewedFiles: body.value.reviewedFiles,
      drafts: body.value.drafts,
      ...(body.value.verdict ? { verdict: body.value.verdict } : {}),
    }

    const saved = ctx.progress.put(progress)

    // Mirror the checkmarks into GitHub's native "Viewed" state (§11).
    await ctx.review.syncViewedFiles(target, saved.reviewedFiles)

    return reply.send(saved)
  })
}
