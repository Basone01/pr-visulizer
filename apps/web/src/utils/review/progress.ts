import type { DraftComment, ReviewProgress } from "@pr-visulizer/shared"

// Pure edits to ReviewProgress. PUT /progress is full-state replacement (§9), so
// every change produces a whole new object — the simplest possible sync.

// A draft's stable identity: its file, side and (start..)end line range. Two drafts can never
// occupy the exact same range on the same side, so this keys edit/delete without a schema `id`.
export function draftKey(draft: DraftComment): string {
  const start = draft.startLine ?? draft.line
  return `${draft.path}:${draft.side}:${start}-${draft.line}`
}

// Upsert a draft: a new range appends, an existing range (same key) is replaced. Keeps the
// list free of duplicate comments on one range.
export function addDraft(progress: ReviewProgress, draft: DraftComment): ReviewProgress {
  const key = draftKey(draft)
  const others = progress.drafts.filter((existing) => draftKey(existing) !== key)

  return { ...progress, drafts: [...others, draft] }
}

export function updateDraftBody(
  progress: ReviewProgress,
  key: string,
  body: string
): ReviewProgress {
  const drafts = progress.drafts.map((draft) =>
    draftKey(draft) === key ? { ...draft, body } : draft
  )

  return { ...progress, drafts }
}

export function deleteDraft(progress: ReviewProgress, key: string): ReviewProgress {
  const drafts = progress.drafts.filter((draft) => draftKey(draft) !== key)

  return { ...progress, drafts }
}

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
