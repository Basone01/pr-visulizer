import { z } from "zod"

// One row in the home-screen PR picker (docs/tauri-architecture.md §5). A summary is
// the cheap listing shape — not the full analysis — mapped from GitHub's open-PR list.
// The schema is the single source of truth; the type is inferred, never hand-written.
export const prSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(), // the PR opener's login
  updatedAt: z.string(), // ISO-8601 timestamp; the list sorts newest-updated first
})
export type PrSummary = z.infer<typeof prSummarySchema>
