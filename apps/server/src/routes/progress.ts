import type { PrTarget } from "@pr-visulizer/engine"
import { type ReviewProgress, reviewProgressSchema } from "@pr-visulizer/shared"
import type { FastifyInstance } from "fastify"

import type { ProgressKey } from "../services/progressStore/index.js"
import {
  type AppContext,
  badRequest,
  parse,
  prParamsSchema,
  requireUser,
  toTarget,
} from "./context.js"

// Review-progress read/write (docs/architecture.md §9, §11). PUT is idempotent full-state
// replacement — the simplest possible checkmark/draft sync. Identity fields are taken from
// the path + session + PR head (never trusted from the body).
//
// BOTH verbs reconcile the checkmarks with GitHub's own "Viewed" state, because both are
// moments where the two copies can have drifted: a reviewer may have ticked files on
// github.com between two visits (GET), or here in the app (PUT). That does mean a GET can
// write — to GitHub, and to the stored ancestor. It is the only way an un-view done on
// github.com can ever reach a reviewer who never touches a checkmark in this app.

export function registerProgressRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Merge the stored checkmarks with GitHub's Viewed state, persist the result, and hand back
  // the progress the SPA should render — with the sync status attached so a GitHub failure is
  // visible instead of silently reverting a checkmark.
  async function reconcileAndSave(
    target: PrTarget,
    key: ProgressKey,
    progress: ReviewProgress
  ): Promise<ReviewProgress> {
    const base = ctx.progress.getSyncedViewedFiles(key)

    const reconciled = await ctx.viewedSync.reconcile({
      target,
      local: progress.reviewedFiles,
      base,
    })

    const saved = ctx.progress.put({ ...progress, reviewedFiles: reconciled.reviewedFiles })

    // Only advance the ancestor when GitHub actually confirmed the write (see viewedSync):
    // recording a guess here is what would turn one failed request into a phantom un-view.
    if (reconciled.syncedViewedFiles) {
      ctx.progress.putSyncedViewedFiles(key, reconciled.syncedViewedFiles)
    }

    return { ...saved, viewedSync: reconciled.sync }
  }

  app.get("/api/prs/:owner/:repo/:number/progress", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const target = toTarget(params.value)
    // Only the head SHA is needed to key the row — `getPullMeta` is the one light call for it,
    // where `getPullRequest` would paginate every changed file WITH its patch.
    const pr = await ctx.gateway.getPullMeta(target)

    const key: ProgressKey = {
      userId: user.userId,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.number,
      headSha: pr.headSha,
    }

    const existing = ctx.progress.get(key)

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

    return reply.send(await reconcileAndSave(target, key, progress))
  })

  app.put("/api/prs/:owner/:repo/:number/progress", async (req, reply) => {
    const user = requireUser(req, reply, ctx)
    if (!user) return reply

    const params = parse(prParamsSchema, req.params)
    if (!params.ok) return badRequest(reply, params.issues)

    const body = parse(reviewProgressSchema, req.body)
    if (!body.ok) return badRequest(reply, body.issues)

    const target = toTarget(params.value)
    const pr = await ctx.gateway.getPullMeta(target)

    // Server-authoritative identity: only the reviewer's own state (files, drafts, verdict)
    // is taken from the body. `viewedSync` is server-DERIVED and deliberately dropped here —
    // a client does not get to declare its own sync healthy.
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

    const key: ProgressKey = {
      userId: progress.userId,
      owner: progress.owner,
      repo: progress.repo,
      prNumber: progress.prNumber,
      headSha: progress.headSha,
    }

    return reply.send(await reconcileAndSave(target, key, progress))
  })
}
