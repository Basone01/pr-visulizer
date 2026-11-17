import {
  type FileOmission,
  type GeneratedEvidence,
  treatedAsGeneratedText,
} from "@pr-visulizer/shared"

import styles from "./Diff.module.css"

const BYTES_PER_KIB = 1024

type LineCounts = {
  // The file's line counts from the PR, the only size known without reading the patch.
  additions: number
  deletions: number
}

type GeneratedNoticeProps = LineCounts & {
  evidence: GeneratedEvidence
  onShowAnyway: () => void
  onOpenOnGitHub: () => void
}

// A file treated as generated: not analysed and not counted toward review. That is a label from
// its name or shape, which the PR author controls, so the notice never calls the file safe.
export function GeneratedNotice({
  evidence,
  additions,
  deletions,
  onShowAnyway,
  onOpenOnGitHub,
}: GeneratedNoticeProps) {
  return (
    <div className={styles.patchState} role="status">
      <p className={styles.patchStateTitle}>Treated as generated, not shown</p>
      <p>
        {treatedAsGeneratedText(evidence)}, so it is not analysed or counted. That is not a check
        that the file is safe.
      </p>
      <LineCountText additions={additions} deletions={deletions} />
      <div className={styles.patchStateActions}>
        <button type="button" className={styles.patchStateButton} onClick={onShowAnyway}>
          Show diff anyway
        </button>
        <OpenOnGitHubButton onClick={onOpenOnGitHub} />
      </div>
    </div>
  )
}

type OmittedDiffNoticeProps = LineCounts & {
  omission: FileOmission
  // A file treated as generated whose diff was asked for anyway: it is NOT part of the review,
  // so the notice only says the diff cannot be shown.
  treatedAsGenerated: boolean
  onOpenOnGitHub: () => void
}

// A file whose diff cannot be shown. Only the diff is missing: the file is still in the review.
// No Retry, because the same read gives the same answer.
export function OmittedDiffNotice({
  omission,
  treatedAsGenerated,
  additions,
  deletions,
  onOpenOnGitHub,
}: OmittedDiffNoticeProps) {
  const isTooLarge = omission.reason === "too-large"
  const limitKib = omission.limitBytes === undefined ? null : omission.limitBytes / BYTES_PER_KIB
  const why = isTooLarge
    ? limitKib === null
      ? "GitHub does not provide a diff this large."
      : `Its diff is over the ${limitKib} KiB limit.`
    : `Its diff could not be read: ${omission.message ?? "unknown error"}`

  return (
    <div className={styles.patchState} role="status">
      <p className={styles.patchStateTitle}>
        {isTooLarge ? "Diff too large to show" : "Diff could not be read"}
      </p>
      <p>
        {why}{" "}
        {treatedAsGenerated ? "It cannot be shown here." : "The file is still part of the review."}
      </p>
      <LineCountText additions={additions} deletions={deletions} />
      <div className={styles.patchStateActions}>
        <OpenOnGitHubButton onClick={onOpenOnGitHub} />
      </div>
    </div>
  )
}

type PatchLoadErrorProps = {
  message: string
  onRetry: () => void
}

// A load that failed for a reason that may pass (network, GitHub). Ends here, never in an
// endless "Loading diff…".
export function PatchLoadError({ message, onRetry }: PatchLoadErrorProps) {
  return (
    <div className={styles.patchState} role="alert">
      <p className={styles.patchStateTitle}>Couldn't load this diff</p>
      <p>{message}</p>
      <div className={styles.patchStateActions}>
        <button type="button" className={styles.patchStateButton} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}

function LineCountText({ additions, deletions }: LineCounts) {
  return (
    <p className="mono">
      +{additions} −{deletions} lines
    </p>
  )
}

function OpenOnGitHubButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.patchStateButton} onClick={onClick}>
      Open on GitHub
    </button>
  )
}
