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

// An EXISTING published review comment fetched back from GitHub (any author), as opposed to a
// local unsent draft above. GET /repos/:o/:r/pulls/:n/comments (verified 2026-07-23 against
// docs.github.com/en/rest/pulls/comments). Field names are app-idiomatic; the gateway maps the
// REST row to this shape so nothing upstream sees Octokit's snake_case.
export const reviewCommentSchema = z.object({
  // GitHub's comment id — the thread key, and the target a reply points at via inReplyToId.
  id: z.number().int(),
  path: z.string(),
  // The head-version line the comment anchors to. NULLABLE on purpose: an OUTDATED comment
  // (its line force-pushed away) and a file-level comment (subject_type "file") both come back
  // with no line, and the doc's create-schema marks `line` non-null but a response for those
  // does not — so we parse it as nullable and treat null as "not anchored to a visible line".
  line: z.number().int().nullable(),
  // First line of a multi-line range; null for a single-line or file-level comment.
  startLine: z.number().int().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  // The comment this one replies to (GitHub's in_reply_to_id) — the threading chain. null on a
  // thread root.
  inReplyToId: z.number().int().nullable(),
  // The comment author's GitHub login (user.login).
  author: z.string(),
  // GitHub-flavored markdown — rendered through the sanitizing MarkdownContent wrapper.
  body: z.string(),
  createdAt: z.string(),
})
export type ReviewComment = z.infer<typeof reviewCommentSchema>

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
