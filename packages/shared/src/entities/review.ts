import { z } from "zod"

// Review progress is per user, per PR, per SHA (docs/architecture.md §3).
// It references only file PATHS, never edges — so it survives an engine swap (§4.2).

export const draftCommentSchema = z.object({
  path: z.string(),
  // The LAST line of the comment, in the head version. For a single-line comment it is
  // the only line; for a multi-line range it is GitHub's `line` (paired with startLine).
  line: z.number().int(),
  // Present only for a multi-line range comment — GitHub's `start_line` (§11). Omitted
  // for a single-line comment, so the range fields are sent only when it is a real range.
  startLine: z.number().int().optional(),
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
})
export type DraftComment = z.infer<typeof draftCommentSchema>

// Whether the checkmarks in `reviewedFiles` are actually mirrored in GitHub's own "Viewed"
// state right now (§11). Server-DERIVED and transient — it is never persisted and never read
// from a request body, so a GitHub write that fails can surface as degraded sync in the UI
// instead of silently rolling the reviewer's checkmark back.
export const viewedSyncSchema = z.object({
  status: z.enum(["synced", "degraded"]),
  reason: z.string().optional(),
})
export type ViewedSync = z.infer<typeof viewedSyncSchema>

export const reviewProgressSchema = z.object({
  userId: z.string(),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string(),
  reviewedFiles: z.array(z.string()), // the checkmarks
  drafts: z.array(draftCommentSchema),
  verdict: z.enum(["approve", "request_changes", "comment"]).optional(),
  viewedSync: viewedSyncSchema.optional(),
})
export type ReviewProgress = z.infer<typeof reviewProgressSchema>
