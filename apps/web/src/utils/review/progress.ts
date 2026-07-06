import type { ReviewProgress } from "@pr-visulizer/shared"

// Pure edits to ReviewProgress. PUT /progress is full-state replacement (§9), so
// every change produces a whole new object — the simplest possible sync.

export function toggleReviewedFile(progress: ReviewProgress, path: string): ReviewProgress {
  const isReviewed = progress.reviewedFiles.includes(path)

  const reviewedFiles = isReviewed
    ? progress.reviewedFiles.filter((reviewed) => reviewed !== path)
    : [...progress.reviewedFiles, path]

  return { ...progress, reviewedFiles }
}

export function setVerdict(
  progress: ReviewProgress,
  verdict: NonNullable<ReviewProgress["verdict"]>
): ReviewProgress {
  return { ...progress, verdict }
}
