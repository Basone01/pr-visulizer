import type { RankedFile, SkippedFile } from "../entities/analysis.js"
import { comparePathAscending } from "./compare.js"
import type { DependencyEdge } from "./graph.js"
import type { RankingPolicy } from "./policy.js"
import { type RankingFileInput, rankFiles } from "./rank.js"

// The review queue's order (docs/architecture.md §8): the ranked files, then the skipped ones.
// Every caller that orders a PR's files goes through here, so a skipped file can never be
// ranked by one of them and left out by another. rankFiles itself never sees a skipped file:
// with none skipped its input, and so its output, is exactly what it was before.

export type ReviewOrderInput = {
  files: RankingFileInput[]
  edges: DependencyEdge[] // file-level dependency edges: `from` depends on `to`
  skipped: SkippedFile[]
}

export type ReviewOrder = {
  ranked: RankedFile[]
  // The changed files left out of the ranking, in path order, each with its reason. No rank.
  skipped: SkippedFile[]
}

export function rankReviewFiles(input: ReviewOrderInput, policy: RankingPolicy): ReviewOrder {
  const { reviewable, skipped } = splitSkippedFiles(input.files, input.skipped)

  return { ranked: rankFiles({ files: reviewable, edges: input.edges }, policy), skipped }
}

// The one split between files that are ranked and files that are skipped. The live readiness
// and best-next math (dynamic.ts) must walk the same reviewable set, so it is exported too.
export function splitSkippedFiles<File extends { path: string }>(
  files: File[],
  skipped: SkippedFile[]
): { reviewable: File[]; skipped: SkippedFile[] } {
  const changedPaths = new Set(files.map((file) => file.path))
  const skipByPath = new Map(
    skipped.filter((skip) => changedPaths.has(skip.path)).map((skip) => [skip.path, skip])
  )

  return {
    reviewable: files.filter((file) => !skipByPath.has(file.path)),
    skipped: [...skipByPath.values()].sort((a, b) => comparePathAscending(a.path, b.path)),
  }
}
