import { z } from "zod"

// The repo-source boundary shapes (docs/tauri-architecture.md §6, deep-only desktop). Kept
// here — with the domain types, dependencies pointing toward entities — so the client, the
// sources, the registry and the UI all speak the same types without import cycles.

// A user-linked local clone: reads happen from ITS git object DB at the PR head, so the
// GitHub API is only needed for PR meta/patches — and the user's working tree is never
// touched (fetch only, no checkout).
export type RepoLink = {
  path: string // absolute folder of the local clone
  owner: string
  repo: string
}

export const repoLinkSchema = z.object({
  path: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
})

export const repoLinksSchema = z.array(repoLinkSchema)

// The app-storage key the linked-repo registry persists under.
export const REPO_LINKS_KEY = "repoLinks"

// The app-storage key the managed-clone folder persists under (docs/tauri-architecture.md §6).
export const CLONE_ROOT_KEY = "cloneRoot"

// Deep analysis needs SOMEWHERE to read the repo from: a linked local clone, or a managed
// clone (which needs the clone-root folder). When neither exists the client rejects with
// THIS typed error so the UI renders the locate-vs-clone prompt instead of a generic
// failure — the boundary decides the UX, not a string match.
export class NeedsRepoSourceError extends Error {
  readonly kind = "needs-repo-source"
  readonly owner: string
  readonly repo: string

  constructor(owner: string, repo: string) {
    super(`no linked local clone or clone folder for ${owner}/${repo}`)
    this.name = "NeedsRepoSourceError"
    this.owner = owner
    this.repo = repo
  }
}

export function isNeedsRepoSourceError(error: unknown): error is NeedsRepoSourceError {
  return error instanceof NeedsRepoSourceError
}
