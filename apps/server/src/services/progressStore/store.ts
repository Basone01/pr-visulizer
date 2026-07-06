import type { ReviewProgress } from "@pr-visulizer/shared"
import Database from "better-sqlite3"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/better-sqlite3"

import { CREATE_PROGRESS_TABLE, type ProgressRow, reviewProgressTable } from "./schema.js"

// The progress repository — the ONLY module that touches SQLite/drizzle (node conv.:
// IO lives behind the repository). Callers get plain `ReviewProgress` (the contract),
// never a drizzle row. better-sqlite3 is synchronous, so the interface is too.

export type ProgressKey = {
  userId: string
  owner: string
  repo: string
  prNumber: number
  headSha: string
}

export interface ProgressStore {
  get(key: ProgressKey): ReviewProgress | null
  put(progress: ReviewProgress): ReviewProgress
  close(): void
}

function rowId(key: ProgressKey): string {
  return `${key.userId}:${key.owner}/${key.repo}#${key.prNumber}@${key.headSha}`
}

function toProgress(row: ProgressRow): ReviewProgress {
  const progress: ReviewProgress = {
    userId: row.userId,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.prNumber,
    headSha: row.headSha,
    reviewedFiles: row.reviewedFiles,
    drafts: row.drafts,
  }

  // exactOptionalPropertyTypes: only attach verdict when the row actually has one.
  if (row.verdict) progress.verdict = row.verdict

  return progress
}

export function createProgressStore(databaseUrl = ":memory:"): ProgressStore {
  const sqlite = new Database(databaseUrl)
  sqlite.exec(CREATE_PROGRESS_TABLE)
  const db = drizzle(sqlite)

  function get(key: ProgressKey): ReviewProgress | null {
    const row = db
      .select()
      .from(reviewProgressTable)
      .where(eq(reviewProgressTable.id, rowId(key)))
      .get()
    return row ? toProgress(row) : null
  }

  function put(progress: ReviewProgress): ReviewProgress {
    const id = rowId(progress)
    const values = {
      id,
      userId: progress.userId,
      owner: progress.owner,
      repo: progress.repo,
      prNumber: progress.prNumber,
      headSha: progress.headSha,
      reviewedFiles: progress.reviewedFiles,
      drafts: progress.drafts,
      verdict: progress.verdict ?? null,
    }

    // PUT is idempotent full-state replacement (§9): upsert the whole row.
    db.insert(reviewProgressTable)
      .values(values)
      .onConflictDoUpdate({
        target: reviewProgressTable.id,
        set: {
          reviewedFiles: values.reviewedFiles,
          drafts: values.drafts,
          verdict: values.verdict,
        },
      })
      .run()

    return progress
  }

  function close(): void {
    sqlite.close()
  }

  return { get, put, close }
}
