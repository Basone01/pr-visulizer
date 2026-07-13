import type { GithubGateway, PrTarget } from "@pr-visulizer/engine"
import type { FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type { Env } from "../config/env.js"
import type { SessionUser } from "../entities/index.js"
import type { AnalysisService } from "../services/analysis/index.js"
import type { ProgressStore } from "../services/progressStore/index.js"
import type { ReviewSubmitService } from "../services/reviewSubmit/index.js"

// Everything the route handlers depend on, wired once in the composition root
// (app.ts) and injected — plain closure DI, no container (node conventions).
export type AppContext = {
  env: Env
  devUserId: string | undefined // local-dev bypass identity (DEV_USER / fake mode)
  gateway: GithubGateway
  analysis: AnalysisService
  progress: ProgressStore
  review: ReviewSubmitService
}

// The PR path params (docs/architecture.md §9). `number` arrives as a string in the URL.
export const prParamsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
})
export type PrParams = z.infer<typeof prParamsSchema>

export function toTarget(params: PrParams): PrTarget {
  return { owner: params.owner, repo: params.repo, number: params.number }
}

// Parse-don't-validate at the HTTP boundary: a typed result the caller must branch on.
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: z.ZodIssue[] }

export function parse<T>(schema: z.ZodType<T>, data: unknown): ParseResult<T> {
  const result = schema.safeParse(data)
  if (!result.success) return { ok: false, issues: result.error.issues }

  return { ok: true, value: result.data }
}

export function badRequest(reply: FastifyReply, issues: z.ZodIssue[]): FastifyReply {
  return reply.code(400).send({ error: "invalid_request", issues })
}

// Session identity (docs/architecture.md §12). In dev/fake mode a bypass user is
// used; otherwise the signed httpOnly cookie carries the user id. The GitHub token
// never rides in the cookie — only the id.
export function getSessionUser(req: FastifyRequest, ctx: AppContext): SessionUser | null {
  if (ctx.devUserId) {
    return { userId: ctx.devUserId, login: ctx.devUserId, name: null, avatarUrl: null }
  }

  const raw = req.cookies[ctx.env.COOKIE_NAME]
  if (!raw) return null

  const unsigned = req.unsignCookie(raw)
  if (!unsigned.valid || unsigned.value == null) return null

  return { userId: unsigned.value, login: unsigned.value, name: null, avatarUrl: null }
}

export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext
): SessionUser | null {
  const user = getSessionUser(req, ctx)
  if (!user) {
    reply.code(401).send({ error: "unauthenticated" })
    return null
  }

  return user
}
