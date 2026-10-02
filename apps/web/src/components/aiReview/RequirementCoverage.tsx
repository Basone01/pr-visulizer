import type {
  AiFinding,
  RequirementCoverage,
  RequirementEvidenceSource,
  RequirementState,
} from "@pr-visulizer/shared"

import styles from "./AiReviewPanel.module.css"

type RequirementCoverageProps = {
  coverage: RequirementCoverage | null
  mismatchFindings: readonly AiFinding[]
}

function stateLabel(state: RequirementState): string {
  if (state === "partially-met") return "Partially met"
  if (state === "not-evidenced") return "Not evidenced"
  if (state === "contradicted") return "Contradicted"
  return "Met"
}

function evidenceSourceLabel(source: RequirementEvidenceSource): string {
  if (source === "jira") return "Jira"
  if (source === "code") return "Code"
  if (source === "test") return "Test"
  return "No code evidence"
}

function Citations({ coverage }: { coverage: RequirementCoverage["items"][number] }) {
  return (
    <ul className={styles.detailList} aria-label={`${coverage.issueKey} requirement citations`}>
      {coverage.evidence.map((evidence, index) => (
        <li key={`${evidence.source}-${evidence.reference}-${index}`}>
          <strong>{evidenceSourceLabel(evidence.source)}:</strong> {evidence.reference} ·{" "}
          {evidence.detail}
        </li>
      ))}
    </ul>
  )
}

function MismatchFindings({ findings }: { findings: readonly AiFinding[] }) {
  const requirementMismatchFindings = findings.filter(
    (finding) => finding.source === "requirement-mismatch"
  )
  if (requirementMismatchFindings.length === 0) return null

  return (
    <section className={styles.section} aria-labelledby="ai-requirement-mismatches">
      <h4 className={styles.sectionTitle} id="ai-requirement-mismatches">
        Requirement mismatch findings
      </h4>
      <ul className={styles.list} aria-label="Requirement mismatch findings">
        {requirementMismatchFindings.map((finding) => (
          <li className={styles.finding} key={finding.id}>
            <span className={styles.badge}>{finding.severity}</span>
            <strong>{finding.title}</strong>
            <div className={styles.meta}>
              {finding.path ?? "unanchored observation"} · {finding.confidence} confidence
            </div>
            <p>{finding.evidence}</p>
            <p className={styles.meta}>Impact: {finding.impact}</p>
            {finding.suggestedFix !== null && (
              <p className={styles.meta}>
                <strong>Suggested fix:</strong> {finding.suggestedFix}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

// Requirement coverage is separate from code findings. A reviewer question records an unresolved
// conflict as data with its Jira citations; it is never transformed into a defect by this view.
export function RequirementCoverage({ coverage, mismatchFindings }: RequirementCoverageProps) {
  if (coverage === null) {
    return (
      <section className={styles.section} aria-labelledby="ai-requirement-coverage">
        <h3 className={styles.sectionTitle} id="ai-requirement-coverage">
          Requirement coverage
        </h3>
        <p className={styles.warning}>
          Requirement verification is unavailable for this run. No Jira requirement content was
          inferred.
        </p>
        <MismatchFindings findings={mismatchFindings} />
      </section>
    )
  }

  return (
    <section className={styles.section} aria-labelledby="ai-requirement-coverage">
      <h3 className={styles.sectionTitle} id="ai-requirement-coverage">
        Requirement coverage
      </h3>
      {coverage.status === "unavailable" && (
        <p className={styles.warning}>
          Requirement verification is unavailable. Code review continues without Jira requirements.
        </p>
      )}
      {coverage.status === "partial" && (
        <p className={styles.warning}>
          Requirement verification is partial. Code review continues with the recorded Jira context.
        </p>
      )}
      {coverage.unavailableIssueKeys.length > 0 && (
        <p className={styles.meta}>
          Unavailable Jira issues: {coverage.unavailableIssueKeys.join(", ")}
        </p>
      )}
      {coverage.items.length === 0 ? (
        <p className={styles.empty}>No Jira acceptance criteria were recorded for this run.</p>
      ) : (
        <ul className={styles.list} aria-label="Requirement coverage items">
          {coverage.items.map((item, index) => (
            <li className={styles.finding} key={`${item.issueKey}-${item.criterion}-${index}`}>
              {item.reviewerQuestion === null ? (
                <>
                  <span className={styles.badge}>{stateLabel(item.state)}</span>
                  <strong>{item.issueKey}</strong> · {item.criterion}
                  <Citations coverage={item} />
                </>
              ) : (
                <>
                  <strong>{item.issueKey}</strong> · {item.criterion}
                  <div
                    className={styles.warning}
                    aria-label={`${item.issueKey} unresolved Jira conflict`}
                  >
                    <strong>Unresolved Jira conflict</strong>
                    <p>{item.reviewerQuestion}</p>
                    <p className={styles.meta}>
                      The cited Jira sources may conflict; choose the authoritative requirement.
                    </p>
                    <Citations coverage={item} />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <MismatchFindings findings={mismatchFindings} />
    </section>
  )
}
