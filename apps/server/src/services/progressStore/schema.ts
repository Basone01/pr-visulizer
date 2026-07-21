import type { DraftComment } from "@pr-visulizer/shared"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The drizzle schema IS the source of truth for the row type (docs/architecture.md
// §3, §14). One row per (user, PR, headSha). Arrays/verdict live as JSON columns —
// simplest possible store for a full-state-replacement PUT (§9).

export const reviewProgressTable = sqliteTable("review_progress", {
  id: text("id").primaryKey(), // `${userId}:${owner}/${repo}#${prNumber}@${headSha}`
  userId: text("user_id").notNull(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  headSha: text("head_sha").notNull(),
  reviewedFiles: text("reviewed_files", { mode: "json" }).$type<string[]>().notNull(),
  drafts: text("drafts", { mode: "json" }).$type<DraftComment[]>().notNull(),
  verdict: text("verdict").$type<"approve" | "request_changes" | "comment">(),
  // GitHub's "Viewed" set as of the last successful sync — the common ancestor the two-way
  // merge needs (§11). NULL means "never synced", which the merge reads as "no ancestor, so
  // union both sides". Sync bookkeeping, not reviewer state: it never leaves the server.
  syncedViewedFiles: text("synced_viewed_files", { mode: "json" }).$type<string[] | null>(),
})

export type ProgressRow = typeof reviewProgressTable.$inferSelect

// Kept in sync with the schema above; run once at startup (MVP has no migration
// runner — schema-driven migrations are the multi-instance upgrade, §14).
export const CREATE_PROGRESS_TABLE = `
  CREATE TABLE IF NOT EXISTS review_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    reviewed_files TEXT NOT NULL,
    drafts TEXT NOT NULL,
    verdict TEXT,
    synced_viewed_files TEXT
  )
`

// `CREATE TABLE IF NOT EXISTS` is a no-op against a database that predates a column, so a
// new column needs its own additive step (still no migration runner — §14). Applied on the
// column list, not on a caught error, so a genuine failure is not swallowed as "already there".
export const ADD_SYNCED_VIEWED_FILES_COLUMN = `
  ALTER TABLE review_progress ADD COLUMN synced_viewed_files TEXT
`
