import type { FastifyInstance } from "fastify"

import { type AppContext, getSessionUser } from "./context.js"

// Auth routes (docs/architecture.md §9, §12). Real OAuth is wired to env config; a
// DEV_USER / GITHUB_FAKE bypass keeps local dev loginless. The GitHub token stays
// server-side and is never serialized into a response.

function authorizeUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // Minimal scope (§12): read repo + write PR reviews.
    scope: "repo",
    state: crypto.randomUUID(),
  })

  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/auth/login — redirect to GitHub OAuth (or explain the dev bypass).
  app.get("/api/auth/login", async (_req, reply) => {
    if (!ctx.env.GITHUB_CLIENT_ID) {
      return reply.code(501).send({
        error: "oauth_not_configured",
        hint: "set DEV_USER or GITHUB_FAKE=1 for local dev",
      })
    }

    return reply.redirect(authorizeUrl(ctx.env.GITHUB_CLIENT_ID, ctx.env.GITHUB_OAUTH_REDIRECT))
  })

  // GET /api/auth/callback — exchange code → token, set the httpOnly session cookie.
  // Token exchange + vault is a later slice; the stub is wired to env config.
  app.get("/api/auth/callback", async (_req, reply) => {
    if (!ctx.env.GITHUB_CLIENT_SECRET) {
      return reply.code(501).send({
        error: "oauth_not_configured",
        hint: "set DEV_USER or GITHUB_FAKE=1 for local dev",
      })
    }

    return reply.code(501).send({ error: "oauth_callback_not_implemented" })
  })

  // GET /api/me — current user (or 401).
  app.get("/api/me", async (req, reply) => {
    const user = getSessionUser(req, ctx)
    if (!user) return reply.code(401).send({ error: "unauthenticated" })

    return reply.send(user)
  })
}
