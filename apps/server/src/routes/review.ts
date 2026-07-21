import { draftCommentSchema } from "@pr-visulizer/shared"
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

// Submit the real GitHub review (docs/architecture.md §11). One POST → one review on
// the PR, anchored to the head commit, with the drafted comments attached.

const submitReviewSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  body: z.string().default(""),
  comments: z.array(draftCommentSchema).default([]),
})

export function registerReviewRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/prs/:owner/:repo/:number/review", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const body = parse(submitReviewSchema, req.body)
    if (!body.ok) return badRequest(reply, body.issues)

    const target = toTarget(params.value)
    const { pr } = await ctx.gateway.getPullRequest(target)

    const result = await ctx.review.submit({
      target,
      headSha: pr.headSha,
      verdict: body.value.verdict,
      body: body.value.body,
      comments: body.value.comments,
    })

    return reply.code(201).send(result)
  })

  // Publish ONE comment immediately (§11) — not a pending review; visible on GitHub at once.
  app.post("/api/prs/:owner/:repo/:number/comments", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const body = parse(draftCommentSchema, req.body)
    if (!body.ok) return badRequest(reply, body.issues)

    const target = toTarget(params.value)
    const meta = await ctx.gateway.getPullMeta(target)

    await ctx.gateway.addReviewComment({
      target,
      commitId: meta.headSha,
      comment: body.value,
    })

    return reply.code(201).send({ ok: true })
  })
}
