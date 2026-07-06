import { z } from "zod"

// Review progress is per user, per PR, per SHA (docs/architecture.md §3).
// It references only file PATHS, never edges — so it survives an engine swap (§4.2).

export const draftCommentSchema = z.object({
  path: z.string(),
  line: z.number().int(), // line in the head version
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
})
export type DraftComment = z.infer<typeof draftCommentSchema>

export const reviewProgressSchema = z.object({
  userId: z.string(),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string(),
  reviewedFiles: z.array(z.string()), // the checkmarks
  drafts: z.array(draftCommentSchema),
  verdict: z.enum(["approve", "request_changes", "comment"]).optional(),
})
export type ReviewProgress = z.infer<typeof reviewProgressSchema>
