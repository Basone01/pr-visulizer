import { describe, expect, it } from "vitest"

import type { JiraMcpReadBroker } from "./jiraClient"
import { createJiraClient, createUnavailableJiraMcpBroker } from "./jiraClient"

const ISSUE = {
  key: "WEB-42",
  url: "https://jira.example.com/browse/WEB-42",
  summary: "Protect the authorization route",
  description: "The route must reject unauthorized access.",
  acceptanceCriteria: ["Unauthorized access returns 403."],
  comments: [
    {
      author: "product-owner",
      createdAt: "2026-09-14T12:00:00.000Z",
      body: "403 is required for unauthenticated requests.",
    },
  ],
  jiraUpdatedAt: "2026-09-14T11:59:00.000Z",
}

function availableFakeBroker(read: JiraMcpReadBroker["readSelectedIssues"]): JiraMcpReadBroker {
  return {
    async probeReadCapability() {
      return {
        status: "available",
        server: "fake-jira-mcp",
        tool: "read_issue",
        diagnostics: ["Test-only fake broker."],
      }
    },
    readSelectedIssues: read,
  }
}

describe("broker-gated Jira MCP client", () => {
  it("uses an allow-once decision for an exact fake read-only tool request", async () => {
    // Arrange
    const receivedRequests: Parameters<JiraMcpReadBroker["readSelectedIssues"]>[0][] = []
    const client = createJiraClient(
      availableFakeBroker(async (request) => {
        receivedRequests.push(request)
        return { issues: [ISSUE], missingIssueKeys: [] }
      })
    )

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-1",
      runId: "run-1",
      issueKeys: ["WEB-42"],
      decision: { requestId: "jira-read-1", decision: "allow-once" },
    })

    // Assert
    expect(context).toEqual({
      status: "available",
      issues: [ISSUE],
      missingIssueKeys: [],
      codeReview: "continues",
      diagnostics: [],
    })
    expect(receivedRequests).toHaveLength(1)
    expect(receivedRequests[0]).toMatchObject({
      issueKeys: ["WEB-42"],
      decision: { requestId: "jira-read-1", decision: "allow-once" },
      request: {
        id: "jira-read-1",
        runId: "run-1",
        kind: "mcp-tool-call",
        server: "fake-jira-mcp",
        tool: "read_issue",
        arguments: '{"issueKeys":["WEB-42"]}',
      },
    })
    expect(receivedRequests[0]?.request.possibleSideEffects).toContain(
      "writes, comments, transitions"
    )
  })

  it("continues code review and never calls the broker when the exact Jira request is denied", async () => {
    // Arrange
    let readCalled = false
    const client = createJiraClient(
      availableFakeBroker(async () => {
        readCalled = true
        return { issues: [ISSUE], missingIssueKeys: [] }
      })
    )

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-2",
      runId: "run-2",
      issueKeys: ["WEB-42"],
      decision: { requestId: "jira-read-2", decision: "deny" },
    })

    // Assert
    expect(readCalled).toBe(false)
    expect(context).toEqual({
      status: "unavailable",
      issues: [],
      missingIssueKeys: ["WEB-42"],
      codeReview: "continues",
      diagnostics: ["Jira read access was denied for this exact request."],
    })
  })

  it("treats a decision for another request ID as denied without calling the broker", async () => {
    // Arrange
    let readCalled = false
    const client = createJiraClient(
      availableFakeBroker(async () => {
        readCalled = true
        return { issues: [ISSUE], missingIssueKeys: [] }
      })
    )

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-expected",
      runId: "run-expected",
      issueKeys: ["WEB-42"],
      decision: { requestId: "jira-read-other", decision: "allow-once" },
    })

    // Assert
    expect(readCalled).toBe(false)
    expect(context.missingIssueKeys).toEqual(["WEB-42"])
    expect(context.diagnostics).toEqual(["Jira read access was denied for this exact request."])
  })

  it("marks an unreadable selected issue partial and reports its exact missing key", async () => {
    // Arrange
    const client = createJiraClient(
      availableFakeBroker(async () => ({ issues: [ISSUE], missingIssueKeys: ["OPS-9"] }))
    )

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-partial",
      runId: "run-partial",
      issueKeys: ["WEB-42", "OPS-9"],
      decision: { requestId: "jira-read-partial", decision: "allow-once" },
    })

    // Assert
    expect(context).toEqual({
      status: "partial",
      issues: [ISSUE],
      missingIssueKeys: ["OPS-9"],
      codeReview: "continues",
      diagnostics: [],
    })
  })

  it("continues with exact missing issues and diagnostics when no local Jira schema is proven", async () => {
    // Arrange
    const client = createJiraClient(createUnavailableJiraMcpBroker())

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-3",
      runId: "run-3",
      issueKeys: ["WEB-42", "OPS-9"],
      decision: { requestId: "jira-read-3", decision: "allow-once" },
    })

    // Assert
    expect(context.status).toBe("unavailable")
    expect(context.issues).toEqual([])
    expect(context.missingIssueKeys).toEqual(["WEB-42", "OPS-9"])
    expect(context.codeReview).toBe("continues")
    expect(context.diagnostics).toContain(
      "Installed Jira MCP declarations and tool schemas have not been proven locally."
    )
  })

  it("jira_probe_failure_returns_unavailable_exact_missing_keys", async () => {
    // Arrange
    let readCalled = false
    const client = createJiraClient({
      async probeReadCapability() {
        throw new Error("broker unavailable")
      },
      async readSelectedIssues() {
        readCalled = true
        return { issues: [ISSUE], missingIssueKeys: [] }
      },
    })

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-probe-failed",
      runId: "run-probe-failed",
      issueKeys: ["WEB-42", "OPS-9"],
      decision: { requestId: "jira-read-probe-failed", decision: "allow-once" },
    })

    // Assert
    expect(readCalled).toBe(false)
    expect(context).toEqual({
      status: "unavailable",
      issues: [],
      missingIssueKeys: ["WEB-42", "OPS-9"],
      codeReview: "continues",
      diagnostics: ["Jira MCP capability probe could not complete."],
    })
  })

  it("continues with all selected issues missing when a broker read fails", async () => {
    // Arrange
    const client = createJiraClient(
      availableFakeBroker(async () => {
        throw new Error("access denied")
      })
    )

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-failed",
      runId: "run-failed",
      issueKeys: ["WEB-42"],
      decision: { requestId: "jira-read-failed", decision: "allow-once" },
    })

    // Assert
    expect(context).toEqual({
      status: "unavailable",
      issues: [],
      missingIssueKeys: ["WEB-42"],
      codeReview: "continues",
      diagnostics: ["Jira MCP read retrieval could not complete."],
    })
  })

  it("rejects malformed fake MCP output rather than inferring Jira requirements", async () => {
    // Arrange
    const client = createJiraClient(
      availableFakeBroker(async () => ({ issues: [{ key: "WEB-42", summary: "Missing URL" }] }))
    )

    // Act
    const context = await client.readSelectedIssues({
      requestId: "jira-read-4",
      runId: "run-4",
      issueKeys: ["WEB-42"],
      decision: { requestId: "jira-read-4", decision: "allow-once" },
    })

    // Assert
    expect(context).toEqual({
      status: "unavailable",
      issues: [],
      missingIssueKeys: ["WEB-42"],
      codeReview: "continues",
      diagnostics: ["The broker returned an invalid Jira MCP read response."],
    })
  })
})
