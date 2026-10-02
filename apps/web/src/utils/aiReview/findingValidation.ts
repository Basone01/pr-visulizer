import {
  type AiFinding,
  type ReviewCoverage,
  type ReviewRunOutput,
  type SelectedJiraCriterion,
  reviewRunOutputSchema,
  selectedJiraCriterionSchema,
} from "@pr-visulizer/shared"

import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"

export type RecordedReviewPatches = Readonly<Record<string, string>>

// Terminal output validation accepts patches only when their revision pair matches the immutable
// run being finalized. The patch text itself remains the exact base-to-head evidence for anchors.
export type RevisionPinnedReviewPatches = Readonly<{
  baseSha: string
  headSha: string
  patches: RecordedReviewPatches
}>

export type FindingAnchorValidationError = {
  findingId: string
  reason: string
}

export type FindingAnchorValidation =
  { valid: true; errors: [] } | { valid: false; errors: FindingAnchorValidationError[] }

export type ReviewOutputTerminalValidation =
  | {
      status: "completed"
      output: ReviewRunOutput
      partial: boolean
    }
  | {
      status: "invalid"
      errors: string[]
    }

function invalidAnchor(finding: AiFinding, reason: string): FindingAnchorValidationError {
  return { findingId: finding.id, reason }
}

function patchLineNumbers(patch: string, side: "LEFT" | "RIGHT"): Set<number> {
  const lines = parseUnifiedDiff(patch).lines
  const lineNumbers = new Set<number>()

  for (const line of lines) {
    const lineNumber = side === "LEFT" ? line.oldLine : line.newLine
    if (lineNumber !== null) lineNumbers.add(lineNumber)
  }

  return lineNumbers
}

function validateAnchoredFinding(
  finding: AiFinding,
  patches: RecordedReviewPatches
): FindingAnchorValidationError | null {
  if (finding.side === null) return null

  if (finding.path === null) {
    return invalidAnchor(finding, "Anchored findings require a path")
  }
  if (finding.startLine === null || finding.endLine === null) {
    return invalidAnchor(finding, "Anchored findings require a complete line range")
  }
  if (finding.endLine < finding.startLine) {
    return invalidAnchor(finding, "Finding end line must not precede its start line")
  }

  const patch = patches[finding.path]
  if (patch === undefined) {
    return invalidAnchor(finding, "Finding path has no recorded base-to-head patch")
  }

  const validLines = patchLineNumbers(patch, finding.side)
  const rangeLength = finding.endLine - finding.startLine + 1
  if (rangeLength > validLines.size) {
    return invalidAnchor(
      finding,
      `Finding ${finding.side} range is not present in the recorded patch`
    )
  }

  for (let line = finding.startLine; line <= finding.endLine; line += 1) {
    if (!validLines.has(line)) {
      return invalidAnchor(
        finding,
        `Finding ${finding.side} line ${line} is not present in the recorded patch`
      )
    }
  }

  return null
}

// A finding is inline-commentable only when its claimed side and every line in its range are in
// the immutable base-to-head patch recorded for the run. Side-null observations remain advisory:
// they may cite unchanged source, but cannot be promoted as inline GitHub comments.
export function validateFindingAnchors(
  findings: AiFinding[],
  patches: RecordedReviewPatches
): FindingAnchorValidation {
  const errors = findings
    .map((finding) => validateAnchoredFinding(finding, patches))
    .filter((error): error is FindingAnchorValidationError => error !== null)

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors }
}

export function isPartialReviewCoverage(coverage: ReviewCoverage): boolean {
  return (
    coverage.skipped.length > 0 ||
    coverage.failedChunks.length > 0 ||
    coverage.missingContent.length > 0 ||
    coverage.excludedSensitivePaths.length > 0 ||
    !coverage.synthesisCompleted
  )
}

function criterionKey(criterion: SelectedJiraCriterion): string {
  return `${criterion.issueKey}\u0000${criterion.criterion}`
}

function validateRequirementCoverage(
  output: ReviewRunOutput,
  selectedJiraCriteria: readonly SelectedJiraCriterion[]
): string[] {
  const selectedCriteria = selectedJiraCriterionSchema.array().parse(selectedJiraCriteria)
  const selectedCriterionKeys = new Set(selectedCriteria.map(criterionKey))
  const mismatchFindings = output.findings.filter(
    (finding) => finding.source === "requirement-mismatch"
  )

  if (output.requirementCoverage === null) {
    return mismatchFindings.map(
      (finding) => `${finding.id}: requirement mismatch requires requirement coverage`
    )
  }

  const seenCoverageCriteria = new Set<string>()
  const duplicateCoverageErrors = output.requirementCoverage.items.flatMap((item) => {
    const key = criterionKey(item)
    if (!seenCoverageCriteria.has(key)) {
      seenCoverageCriteria.add(key)
      return []
    }

    return [
      `${item.issueKey}: duplicate requirement conclusions for "${item.criterion}" are invalid`,
    ]
  })
  if (duplicateCoverageErrors.length > 0) return duplicateCoverageErrors

  const coverageItemsByCriterion = new Map(
    output.requirementCoverage.items.map((item) => [criterionKey(item), item])
  )
  const coverageErrors = output.requirementCoverage.items.flatMap((item) => {
    const key = criterionKey(item)
    return selectedCriterionKeys.has(key)
      ? []
      : [`${item.issueKey}: requirement conclusion does not reference a selected Jira criterion`]
  })
  const mismatchErrors = mismatchFindings.flatMap((finding) => {
    const criterion = finding.requirementCriterion
    if (criterion === undefined) {
      return [`${finding.id}: requirement mismatch has no Jira criterion reference`]
    }

    const key = criterionKey(criterion)
    if (!selectedCriterionKeys.has(key)) {
      return [`${finding.id}: requirement mismatch does not reference a selected Jira criterion`]
    }

    const conclusion = coverageItemsByCriterion.get(key)
    if (conclusion === undefined) {
      return [`${finding.id}: requirement mismatch has no matching requirement conclusion`]
    }
    if (conclusion.reviewerQuestion !== null) {
      return [`${finding.id}: requirement mismatch cannot reference a conflicting requirement`]
    }

    return []
  })

  return [...coverageErrors, ...mismatchErrors]
}

// Provider prose never bypasses this boundary: malformed output and invalid diff anchors become
// invalid terminal runs. Schema-valid output with disclosed incomplete coverage remains completed
// but carries partial=true so callers cannot present it as a complete PR review.
export function validateReviewRunOutput(
  output: unknown,
  patches: RecordedReviewPatches,
  selectedJiraCriteria: readonly SelectedJiraCriterion[] = []
): ReviewOutputTerminalValidation {
  const parsedOutput = reviewRunOutputSchema.safeParse(output)
  if (!parsedOutput.success) {
    return {
      status: "invalid",
      errors: parsedOutput.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    }
  }

  const anchors = validateFindingAnchors(parsedOutput.data.findings, patches)
  if (!anchors.valid) {
    return {
      status: "invalid",
      errors: anchors.errors.map((error) => `${error.findingId}: ${error.reason}`),
    }
  }

  const requirementCoverageErrors = validateRequirementCoverage(
    parsedOutput.data,
    selectedJiraCriteria
  )
  if (requirementCoverageErrors.length > 0) {
    return { status: "invalid", errors: requirementCoverageErrors }
  }

  return {
    status: "completed",
    output: parsedOutput.data,
    partial: isPartialReviewCoverage(parsedOutput.data.coverage),
  }
}
