import { z } from "zod"

import type { AiPermissionDecision, AiPermissionRequest } from "@/entity/aiReviewPermissions"

const JIRA_KEY_SCHEMA = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/)

const jiraMcpIssueSchema = z.object({
  key: JIRA_KEY_SCHEMA,
  url: z.string().url(),
  summary: z.string().min(1),
  description: z.string().nullable(),
  acceptanceCriteria: z.array(z.string().min(1)),
  comments: z.array(
    z.object({
      author: z.string().min(1),
      createdAt: z.string().min(1),
      body: z.string().min(1),
    })
  ),
  jiraUpdatedAt: z.string().min(1).nullable(),
})
export type JiraMcpIssue = z.infer<typeof jiraMcpIssueSchema>

const jiraMcpReadResponseSchema = z.object({
  issues: z.array(jiraMcpIssueSchema),
  missingIssueKeys: z.array(JIRA_KEY_SCHEMA),
})

type JiraMcpAvailableCapability = {
  status: "available"
  server: string
  tool: string
  diagnostics: string[]
}

type JiraMcpUnavailableCapability = {
  status: "unavailable"
  server: null
  tool: null
  diagnostics: string[]
}

export type JiraMcpReadCapability = JiraMcpAvailableCapability | JiraMcpUnavailableCapability

export const JIRA_MCP_UNAVAILABLE_DIAGNOSTICS = [
  "Installed Jira MCP declarations and tool schemas have not been proven locally.",
  "No broker-approved read-only Jira tool is available.",
  "Jira retrieval remains disabled; code review can continue without Jira requirements.",
] as const

// This contract is the only future retrieval seam. A real implementation must be Rust-broker
// owned: the webview never receives an executable, arguments, server-start command, or network
// authority. Tests inject a fake broker to prove client-side approval and continuation behavior.
export type JiraMcpReadBroker = {
  probeReadCapability(): Promise<JiraMcpReadCapability>
  readSelectedIssues(input: {
    request: AiPermissionRequest & { kind: "mcp-tool-call" }
    decision: AiPermissionDecision
    issueKeys: string[]
  }): Promise<unknown>
}

export type JiraRequirementContext = {
  status: "available" | "partial" | "unavailable"
  issues: JiraMcpIssue[]
  missingIssueKeys: string[]
  codeReview: "continues"
  diagnostics: string[]
}

export function createUnavailableJiraMcpBroker(): JiraMcpReadBroker {
  return {
    async probeReadCapability() {
      return {
        status: "unavailable",
        server: null,
        tool: null,
        diagnostics: [...JIRA_MCP_UNAVAILABLE_DIAGNOSTICS],
      }
    },
    async readSelectedIssues() {
      throw new Error("Jira MCP read retrieval is unavailable")
    },
  }
}

function uniqueSelectedKeys(issueKeys: readonly string[]): string[] {
  const parsedKeys = issueKeys.map((key) => JIRA_KEY_SCHEMA.parse(key))
  if (new Set(parsedKeys).size !== parsedKeys.length) {
    throw new Error("Selected Jira issue keys must be unique")
  }
  return parsedKeys
}

function unavailableContext(
  issueKeys: string[],
  diagnostics: readonly string[]
): JiraRequirementContext {
  return {
    status: "unavailable",
    issues: [],
    missingIssueKeys: issueKeys,
    codeReview: "continues",
    diagnostics: [...diagnostics],
  }
}

function createReadPermission(
  requestId: string,
  runId: string,
  issueKeys: string[],
  capability: JiraMcpAvailableCapability
): AiPermissionRequest & { kind: "mcp-tool-call" } {
  return {
    id: requestId,
    runId,
    kind: "mcp-tool-call",
    server: capability.server,
    tool: capability.tool,
    arguments: JSON.stringify({ issueKeys }),
    requestedData:
      "Selected issue summary, description, acceptance criteria, comments, authors, timestamps, and Jira updated time",
    possibleSideEffects:
      "Read-only issue retrieval; Jira writes, comments, transitions, and edits are prohibited.",
    reason: "Load reviewer-selected Jira requirements for this review run",
  }
}

function parseBrokerResponse(
  response: unknown,
  selectedKeys: string[]
): JiraRequirementContext | null {
  const parsed = jiraMcpReadResponseSchema.safeParse(response)
  if (!parsed.success) return null

  const selected = new Set(selectedKeys)
  const returnedKeys = parsed.data.issues.map((issue) => issue.key)
  const missing = parsed.data.missingIssueKeys
  if (
    returnedKeys.some((key) => !selected.has(key)) ||
    missing.some((key) => !selected.has(key)) ||
    new Set(returnedKeys).size !== returnedKeys.length ||
    new Set(missing).size !== missing.length ||
    returnedKeys.some((key) => missing.includes(key))
  ) {
    return null
  }

  const unresolved = selectedKeys.filter(
    (key) => !returnedKeys.includes(key) && !missing.includes(key)
  )
  const missingIssueKeys = [...missing, ...unresolved]
  return {
    status: missingIssueKeys.length === 0 ? "available" : "partial",
    issues: parsed.data.issues,
    missingIssueKeys,
    codeReview: "continues",
    diagnostics: [],
  }
}

export function createJiraClient(broker: JiraMcpReadBroker) {
  return {
    async readSelectedIssues(input: {
      requestId: string
      runId: string
      issueKeys: readonly string[]
      decision: AiPermissionDecision
    }): Promise<JiraRequirementContext> {
      const issueKeys = uniqueSelectedKeys(input.issueKeys)
      let capability: JiraMcpReadCapability
      try {
        capability = await broker.probeReadCapability()
      } catch {
        return unavailableContext(issueKeys, ["Jira MCP capability probe could not complete."])
      }
      if (capability.status === "unavailable") {
        return unavailableContext(issueKeys, capability.diagnostics)
      }

      const permission = createReadPermission(input.requestId, input.runId, issueKeys, capability)
      if (input.decision.requestId !== permission.id || input.decision.decision !== "allow-once") {
        return unavailableContext(issueKeys, [
          "Jira read access was denied for this exact request.",
        ])
      }

      try {
        const context = parseBrokerResponse(
          await broker.readSelectedIssues({
            request: permission,
            decision: input.decision,
            issueKeys,
          }),
          issueKeys
        )
        return (
          context ??
          unavailableContext(issueKeys, ["The broker returned an invalid Jira MCP read response."])
        )
      } catch {
        return unavailableContext(issueKeys, ["Jira MCP read retrieval could not complete."])
      }
    },
  }
}

export type JiraClient = ReturnType<typeof createJiraClient>
