import {
  type CommitRange,
  type DraftComment,
  type PrCommitList,
  type PrOverview,
  type PrSummary,
  type RangeDiff,
  type ReviewComment,
  type ReviewProgress,
  type Viewer,
  analysisResultSchema,
  prCommitListSchema,
  prOverviewSchema,
  prSummarySchema,
  rangeDiffSchema,
  reviewCommentSchema,
  reviewProgressSchema,
  viewerSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

import { parseJson, requestJson, requestOk } from "@/utils/api/http"

import type { Engine, PrTarget, RepoRef } from "@/entity/pr"

import type { AnalysisResponse, PrClient, ReviewSubmission } from "../prClient"

// The real BFF client (docs/architecture.md §9). Every response is parsed through a
// shared schema at the boundary. Unused until the BFF lands — fixture mode runs today.

function base(target: PrTarget): string {
  return `/api/prs/${target.owner}/${target.repo}/${target.number}`
}

// The files endpoint returns { path, sha, content, patch } — patch is the unified
// diff for the renderer, null when GitHub omits it (binary, too large, pure rename);
// content is the file at the head sha, the full-file view's input (§10).
const patchResponseSchema = z.object({ patch: z.string().nullable() })
const contentResponseSchema = z.object({ content: z.string().nullable() })

const prSummaryListSchema = z.array(prSummarySchema)
const reviewCommentListSchema = z.array(reviewCommentSchema)

export function createHttpPrClient(): PrClient {
  return {
    async listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]> {
      return parseJson(`/api/repos/${repo.owner}/${repo.repo}/pulls`, prSummaryListSchema)
    },

    async getOverview(target: PrTarget): Promise<PrOverview> {
      return parseJson(base(target), prOverviewSchema)
    },

    async getAnalysis(target: PrTarget, engine: Engine): Promise<AnalysisResponse> {
      const { status, body } = await requestJson(`${base(target)}/analysis?engine=${engine}`)

      // 202 = still running; the caller polls (TanStack Query refetchInterval).
      if (status === 202) return { status: "analyzing" }

      return { status: "ready", result: analysisResultSchema.parse(body) }
    },

    // The BFF is 202-then-poll (§9): there are no per-step events over HTTP, so the panel
    // renders its indeterminate state instead. A no-op unsubscribe keeps the seam uniform.
    subscribeAnalysisProgress(): () => void {
      return () => {}
    },

    async getPatch(target: PrTarget, path: string): Promise<string> {
      const url = `${base(target)}/files/${encodeURI(path)}`
      const parsed = await parseJson(url, patchResponseSchema)

      if (parsed.patch === null) throw new Error(`no diff available for ${path}`)

      return parsed.patch
    },

    async listCommits(target: PrTarget): Promise<PrCommitList> {
      return parseJson(`${base(target)}/commits`, prCommitListSchema)
    },

    async getRangeDiff(target: PrTarget, range: CommitRange): Promise<RangeDiff> {
      const query = new URLSearchParams({ base: range.baseSha, head: range.headSha })

      return parseJson(`${base(target)}/compare?${query}`, rangeDiffSchema)
    },

    // The same files route already serves the head content beside the patch — no new endpoint.
    async addCommentNow(target: PrTarget, comment: DraftComment): Promise<void> {
      await requestJson(`${base(target)}/comments`, {
        method: "POST",
        body: JSON.stringify(comment),
      })
    },

    // GET the same /comments path the POST above writes to — the read side of existing threads.
    listReviewComments(target: PrTarget): Promise<ReviewComment[]> {
      return parseJson(`${base(target)}/comments`, reviewCommentListSchema)
    },

    async getFileAtHead(target: PrTarget, path: string): Promise<string | null> {
      const url = `${base(target)}/files/${encodeURI(path)}`
      const parsed = await parseJson(url, contentResponseSchema)

      return parsed.content
    },

    getProgress(target: PrTarget): Promise<ReviewProgress> {
      return parseJson(`${base(target)}/progress`, reviewProgressSchema)
    },

    putProgress(target: PrTarget, progress: ReviewProgress): Promise<ReviewProgress> {
      return parseJson(`${base(target)}/progress`, reviewProgressSchema, {
        method: "PUT",
        body: JSON.stringify(progress),
      })
    },

    async submitReview(target: PrTarget, submission: ReviewSubmission): Promise<void> {
      await requestJson(`${base(target)}/review`, {
        method: "POST",
        body: JSON.stringify(submission),
      })
    },

    getViewer(): Promise<Viewer> {
      return parseJson(`/api/me`, viewerSchema)
    },

    // 204, no body — the BFF just drops its cached analysis job for this PR.
    invalidatePr(target: PrTarget): Promise<void> {
      return requestOk(`${base(target)}/refresh`, { method: "POST" })
    },
  }
}
