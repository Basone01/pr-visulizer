import type { TrayRow } from "@/entity/viewModels"

// The "next" file in the review queue relative to the open one: the next unreviewed file after
// it, wrapping to the first, never the open file itself. A skipped file (generated, too large)
// is never next: it needs no reading, so the queue steps over it.
export function nextUnreviewedPath(
  rows: ReadonlyArray<Pick<TrayRow, "path" | "reviewed" | "skipReason">>,
  currentPath: string
): string | null {
  const candidates = rows.filter((row) => row.skipReason === null)
  const currentIndex = candidates.findIndex((row) => row.path === currentPath)
  const after = candidates.slice(currentIndex + 1).find((row) => !row.reviewed)
  if (after) return after.path

  const wrapped = candidates.find((row) => !row.reviewed && row.path !== currentPath)
  return wrapped?.path ?? null
}
