// Identifies one PR across every endpoint (docs/architecture.md §9). The SPA never
// talks to api.github.com — every call is keyed by this target and goes to the BFF.
export type PrTarget = {
  owner: string
  repo: string
  number: number
}

// A repository without a specific PR — the home-screen watched-repo list and its open-PR
// picker work at this level (docs/tauri-architecture.md §5).
export type RepoRef = {
  owner: string
  repo: string
}

export type Engine = "fast" | "deep"

export function prKey(target: PrTarget): string {
  return `${target.owner}/${target.repo}/${target.number}`
}

export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`
}

// Parse an "owner/repo" string back into a RepoRef, or null when it isn't that shape.
export function parseRepoRef(value: string): RepoRef | null {
  const parts = value.split("/")
  if (parts.length !== 2) return null

  const [owner, repo] = parts
  if (!owner || !repo) return null

  return { owner, repo }
}
