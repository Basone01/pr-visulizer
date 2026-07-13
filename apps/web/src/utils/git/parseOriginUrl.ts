import type { RepoRef } from "@/entity/pr"

// Derive `{owner, repo}` from a GitHub `origin` remote URL (docs/tauri-architecture.md §6,
// linked repos). Supports the two forms real clones have — ssh scp-style
// `git@github.com:owner/repo.git` and `https://github.com/owner/repo(.git)` — plus the
// explicit `ssh://git@github.com/owner/repo.git` variant git also writes. Anything else
// (non-GitHub host, a bare path) returns null; the caller shows the inline "no GitHub
// origin" error rather than guessing.

const ORIGIN_FORMS = [
  // git@github.com:owner/repo(.git)
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  // ssh://git@github.com/owner/repo(.git)
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  // http(s)://github.com/owner/repo(.git)
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
]

export function parseOriginUrl(url: string): RepoRef | null {
  const trimmed = url.trim()

  for (const form of ORIGIN_FORMS) {
    const match = form.exec(trimmed)
    if (match) return { owner: match[1]!, repo: match[2]! }
  }

  return null
}
