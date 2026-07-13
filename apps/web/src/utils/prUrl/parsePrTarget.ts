import type { PrTarget } from "@/entity/pr"

// Parse-as-you-type for the home screen's URL input (docs/tauri-architecture.md §5). The
// input is an untrusted boundary — this turns a raw string into a typed PrTarget or null,
// and the three accepted forms below double as the inline hint shown for invalid input.
export const ACCEPTED_PR_FORMS = [
  "https://github.com/owner/repo/pull/42",
  "owner/repo#42",
  "owner/repo/42",
] as const

function buildTarget(
  owner: string | undefined,
  repo: string | undefined,
  numberText: string | undefined
): PrTarget | null {
  if (!owner || !repo || !numberText) return null
  if (!/^\d+$/.test(numberText)) return null

  const number = Number(numberText)
  if (!Number.isInteger(number) || number <= 0) return null

  return { owner, repo, number }
}

// https://github.com/owner/repo/pull/42 (trailing path / query tolerated).
function parseUrlForm(input: string): PrTarget | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0)
  const [owner, repo, keyword, numberText] = segments
  if (keyword !== "pull" && keyword !== "pulls") return null

  return buildTarget(owner, repo, numberText)
}

// owner/repo#42
function parseHashForm(input: string): PrTarget | null {
  const [repoPart, numberText] = input.split("#")
  const [owner, repo, extra] = (repoPart ?? "").split("/")
  if (extra !== undefined) return null

  return buildTarget(owner, repo, numberText)
}

// owner/repo/42
function parseSlashForm(input: string): PrTarget | null {
  const [owner, repo, numberText, extra] = input.split("/")
  if (extra !== undefined) return null

  return buildTarget(owner, repo, numberText)
}

export function parsePrTarget(raw: string): PrTarget | null {
  const input = raw.trim()
  if (input.length === 0) return null

  if (input.includes("://")) return parseUrlForm(input)
  if (input.includes("#")) return parseHashForm(input)

  return parseSlashForm(input)
}
