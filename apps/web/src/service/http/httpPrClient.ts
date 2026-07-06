import {
  type ReviewProgress,
  analysisResultSchema,
  reviewProgressSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

import { parseJson, requestJson } from "@/utils/api/http"

import type { Engine, PrTarget } from "@/entity/pr"

import type { AnalysisResponse, PrClient, ReviewSubmission } from "../prClient"

// The real BFF client (docs/architecture.md §9). Every response is parsed through a
// shared schema at the boundary. Unused until the BFF lands — fixture mode runs today.

function base(target: PrTarget): string {
  return `/api/prs/${target.owner}/${target.repo}/${target.number}`
}

// The files endpoint returns { path, sha, content, patch } — patch is the unified
// diff for the renderer, null when GitHub omits it (binary, too large, pure rename).
const patchResponseSchema = z.object({ patch: z.string().nullable() })

export function createHttpPrClient(): PrClient {
  return {
    async getAnalysis(target: PrTarget, engine: Engine): Promise<AnalysisResponse> {
      const { status, body } = await requestJson(`${base(target)}/analysis?engine=${engine}`)

      // 202 = still running; the caller polls (TanStack Query refetchInterval).
      if (status === 202) return { status: "analyzing" }

      return { status: "ready", result: analysisResultSchema.parse(body) }
    },

    async getPatch(target: PrTarget, path: string): Promise<string> {
      const url = `${base(target)}/files/${encodeURI(path)}`
      const parsed = await parseJson(url, patchResponseSchema)

      if (parsed.patch === null) throw new Error(`no diff available for ${path}`)

      return parsed.patch
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

    async deepen(target: PrTarget): Promise<void> {
      await requestJson(`${base(target)}/analysis/deepen`, { method: "POST" })
    },
  }
}
