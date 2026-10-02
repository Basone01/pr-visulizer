import type {
  AiFinding,
  RequirementCoverage as RequirementCoverageData,
} from "@pr-visulizer/shared"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { RequirementCoverage } from "./RequirementCoverage"

const MISMATCH_FINDING: AiFinding = {
  id: "requirement-mismatch-1",
  title: "Redirect response contradicts the selected requirement",
  severity: "high",
  confidence: "high",
  category: "requirements",
  path: "src/auth/redirect.ts",
  side: "RIGHT",
  startLine: 10,
  endLine: 10,
  evidence: "The handler returns 302 for an unauthorized request.",
  impact: "Unauthorized users can receive the wrong response.",
  suggestedFix: "Return 403 before redirecting.",
  source: "requirement-mismatch",
  requirementCriterion: {
    issueKey: "WEB-42",
    criterion: "Unauthorized access returns 403.",
  },
}

const COVERAGE: RequirementCoverageData = {
  status: "available",
  unavailableIssueKeys: [],
  items: [
    {
      issueKey: "WEB-42",
      criterion: "Unauthorized access returns 403.",
      state: "met",
      evidence: [
        {
          source: "jira",
          reference: "WEB-42 acceptance criterion 1",
          detail: "Unauthorized access returns 403.",
        },
        {
          source: "code",
          reference: "src/auth/redirect.ts:10",
          detail: "The handler rejects unauthorized requests.",
        },
        {
          source: "test",
          reference: "redirect.test.ts:44",
          detail: "The unauthorized case asserts 403.",
        },
      ],
      reviewerQuestion: null,
    },
  ],
}

describe("RequirementCoverage", () => {
  it("renders requirement states, Jira/code/test citations, and separate mismatch findings", () => {
    // Arrange
    render(<RequirementCoverage coverage={COVERAGE} mismatchFindings={[MISMATCH_FINDING]} />)

    // Act
    const coverageItem = screen.getByRole("list", { name: "Requirement coverage items" })
    const mismatchItem = screen.getByRole("list", { name: "Requirement mismatch findings" })

    // Assert
    expect(coverageItem).toHaveTextContent("Met")
    expect(coverageItem).toHaveTextContent("Jira: WEB-42 acceptance criterion 1")
    expect(coverageItem).toHaveTextContent("Code: src/auth/redirect.ts:10")
    expect(coverageItem).toHaveTextContent("Test: redirect.test.ts:44")
    expect(mismatchItem).toHaveTextContent("Redirect response contradicts the selected requirement")
    expect(mismatchItem).toHaveTextContent("The handler returns 302 for an unauthorized request.")
  })

  it("requirement_mismatch_renders_suggested_fix_in_requirement_section", () => {
    // Arrange
    render(<RequirementCoverage coverage={COVERAGE} mismatchFindings={[MISMATCH_FINDING]} />)

    // Act
    const requirementCoverage = screen.getByRole("list", { name: "Requirement coverage items" })
    const mismatchFindings = screen.getByRole("list", { name: "Requirement mismatch findings" })

    // Assert
    expect(within(mismatchFindings).getByText("Return 403 before redirecting.")).toBeInTheDocument()
    expect(within(requirementCoverage).queryByText("Return 403 before redirecting.")).toBeNull()
  })

  it("conflicting_requirement_hides_authoritative_state_badge", () => {
    // Arrange
    const conflictingCoverage: RequirementCoverageData = {
      status: "available",
      unavailableIssueKeys: [],
      items: [
        {
          issueKey: "WEB-42",
          criterion: "Authorization response status.",
          state: "contradicted",
          evidence: [
            {
              source: "jira",
              reference: "WEB-42 description · product-owner · 2026-09-14T10:00:00Z",
              detail: "Description requires a 401 response.",
            },
            {
              source: "jira",
              reference: "WEB-42 comment · security-lead · 2026-09-14T11:00:00Z",
              detail: "Comment requires a 403 response.",
            },
          ],
          reviewerQuestion:
            "Which Jira requirement is authoritative: the description's 401 or the comment's 403?",
        },
      ],
    }

    // Act
    render(<RequirementCoverage coverage={conflictingCoverage} mismatchFindings={[]} />)

    // Assert
    expect(screen.getByLabelText("WEB-42 unresolved Jira conflict")).toHaveTextContent(
      "Which Jira requirement is authoritative"
    )
    expect(screen.getByText("Unresolved Jira conflict")).toBeInTheDocument()
    expect(screen.getByText(/product-owner.*2026-09-14T10:00:00Z/)).toBeInTheDocument()
    expect(screen.getByText(/security-lead.*2026-09-14T11:00:00Z/)).toBeInTheDocument()
    expect(screen.queryByText("Contradicted")).toBeNull()
    expect(screen.queryByRole("heading", { name: "Requirement mismatch findings" })).toBeNull()
  })

  it("keeps unavailable Jira context explicit with exact missing issue keys", () => {
    // Arrange
    const unavailableCoverage: RequirementCoverageData = {
      status: "unavailable",
      items: [],
      unavailableIssueKeys: ["WEB-42", "OPS-9"],
    }

    // Act
    render(<RequirementCoverage coverage={unavailableCoverage} mismatchFindings={[]} />)

    // Assert
    expect(
      screen.getByText(
        "Requirement verification is unavailable. Code review continues without Jira requirements."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("Unavailable Jira issues: WEB-42, OPS-9")).toBeInTheDocument()
    expect(
      screen.getByText("No Jira acceptance criteria were recorded for this run.")
    ).toBeInTheDocument()
  })
})
