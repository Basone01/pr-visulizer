// Identifies one PR across every endpoint (docs/architecture.md §9). The SPA never
// talks to api.github.com — every call is keyed by this target and goes to the BFF.
export type PrTarget = {
  owner: string
  repo: string
  number: number
}

export type Engine = "fast" | "deep"

export function prKey(target: PrTarget): string {
  return `${target.owner}/${target.repo}/${target.number}`
}
