// Jira references arrive from an untrusted PR description. Detection is deliberately pure: it
// identifies candidate keys/URLs for reviewer selection and never follows a link or fetches Jira.
export type DetectedJiraIssue = {
  key: string
  url: string | null
}

const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g
const URL_PATTERN = /https?:\/\/[^\s<>'"`]+/g

function jiraKey(value: string): string | null {
  const candidate = value.toUpperCase()
  return /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(candidate) ? candidate : null
}

function issueFromUrl(rawUrl: string): DetectedJiraIssue | null {
  try {
    const parsed = new URL(rawUrl.replace(/[),.;:!?]+$/, ""))
    const segments = parsed.pathname.split("/").filter(Boolean)
    const browseIndex = segments.findIndex((segment) => segment === "browse")
    const key = browseIndex >= 0 ? jiraKey(segments[browseIndex + 1] ?? "") : null
    if (key === null) return null

    return { key, url: `${parsed.origin}/browse/${key}` }
  } catch {
    return null
  }
}

// One issue is shown once, in description order. A matching Jira browse URL wins over a bare-key
// occurrence because it preserves the reviewer-visible issue origin without causing a fetch.
export function detectJiraIssues(description: string): DetectedJiraIssue[] {
  const candidates: Array<{ index: number; issue: DetectedJiraIssue }> = []

  for (const match of description.matchAll(URL_PATTERN)) {
    const issue = issueFromUrl(match[0])
    if (issue && match.index !== undefined) candidates.push({ index: match.index, issue })
  }
  for (const match of description.matchAll(JIRA_KEY_PATTERN)) {
    const key = jiraKey(match[1] ?? "")
    if (key && match.index !== undefined)
      candidates.push({ index: match.index, issue: { key, url: null } })
  }

  const detected = new Map<string, DetectedJiraIssue>()
  for (const { issue } of candidates.sort((left, right) => left.index - right.index)) {
    const existing = detected.get(issue.key)
    if (!existing || (existing.url === null && issue.url !== null)) detected.set(issue.key, issue)
  }

  return [...detected.values()]
}

// Selection is explicit and rejects keys that were not presented to the reviewer. This function
// does not initiate any Jira/MCP operation; S23 is the only future read retrieval seam.
export function selectDetectedJiraIssues(
  detected: readonly DetectedJiraIssue[],
  selectedKeys: readonly string[]
): DetectedJiraIssue[] {
  const byKey = new Map(detected.map((issue) => [issue.key, issue]))
  const selected = new Set<string>()

  return selectedKeys.map((rawKey) => {
    const key = jiraKey(rawKey)
    if (key === null || !byKey.has(key)) {
      throw new Error(`Jira issue ${rawKey} was not detected in this PR description`)
    }
    if (selected.has(key)) throw new Error(`Jira issue ${key} was selected more than once`)

    selected.add(key)
    return byKey.get(key)!
  })
}
