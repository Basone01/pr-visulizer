import type { PrSummary } from "@pr-visulizer/shared"

// The home screen's per-repo PR picker (docs/tauri-architecture.md §5). Two rules, both here so
// the card stays a renderer:
//
//   - with no search, show only the few most recently updated PRs — a repo with 60 open PRs
//     turned the card into a wall nobody read
//   - with a search, show every match, because the whole point of typing is to reach the PR the
//     cap hid
//
// It filters what the repo card already HAS. The gateway pages through every OPEN pull for the
// repo (octokitGateway.listOpenPullRequests), so client-side filtering covers exactly the set the
// card claims to list — no request per keystroke, and no result the reviewer cannot explain.
// CLOSED and merged PRs are outside that set and stay unfindable here; reaching them needs a new
// gateway call, which is a bigger slice than this one.

// How many PRs the card shows when nothing is typed.
export const RECENT_PULLS_LIMIT = 5

// A number search is a PREFIX on the digits, so "4" finds #42 and #47 while the reviewer is still
// typing. A leading "#" is how people write PR numbers, so it is accepted and ignored.
function matchesNumber(pull: PrSummary, query: string): boolean {
  const digits = query.startsWith("#") ? query.slice(1) : query
  if (digits.length === 0 || !/^\d+$/.test(digits)) return false

  return String(pull.number).startsWith(digits)
}

function matchesTitle(pull: PrSummary, query: string): boolean {
  return pull.title.toLowerCase().includes(query.toLowerCase())
}

export function matchesPullQuery(pull: PrSummary, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) return true

  return matchesNumber(pull, trimmed) || matchesTitle(pull, trimmed)
}

// Newest-updated first, then the two rules above. Sorting here rather than at the call site keeps
// "most recent" true of the RESULT, not just of the input the gateway happened to send.
export function visiblePullRequests(
  pulls: readonly PrSummary[],
  query: string,
  limit: number = RECENT_PULLS_LIMIT
): PrSummary[] {
  const newestFirst = [...pulls].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const searching = query.trim().length > 0

  const matched = newestFirst.filter((pull) => matchesPullQuery(pull, query))

  return searching ? matched : matched.slice(0, limit)
}
