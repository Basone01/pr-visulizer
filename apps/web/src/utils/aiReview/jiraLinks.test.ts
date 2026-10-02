import { describe, expect, it } from "vitest"

import { detectJiraIssues, selectDetectedJiraIssues } from "./jiraLinks"

describe("Jira PR-description links", () => {
  it("detects unique Jira browse URLs and keys without fetching either reference", () => {
    // Arrange
    const description =
      "Implements WEB-42 and https://jira.example.com/browse/OPS-9; WEB-42 is repeated."

    // Act
    const detected = detectJiraIssues(description)

    // Assert
    expect(detected).toEqual([
      { key: "WEB-42", url: null },
      { key: "OPS-9", url: "https://jira.example.com/browse/OPS-9" },
    ])
  })

  it("returns only reviewer-selected detected issues and rejects an undisclosed key", () => {
    // Arrange
    const detected = detectJiraIssues("References WEB-42 and OPS-9")

    // Act
    const selected = selectDetectedJiraIssues(detected, ["OPS-9"])
    const undisclosedSelection = () => selectDetectedJiraIssues(detected, ["SEC-7"])

    // Assert
    expect(selected).toEqual([{ key: "OPS-9", url: null }])
    expect(undisclosedSelection).toThrow("was not detected")
  })
})
