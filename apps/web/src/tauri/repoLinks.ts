import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import type { RepoRef } from "@/entity/pr"
import { REPO_LINKS_KEY, type RepoLink, repoLinksSchema } from "@/entity/repoSource"

// The linked-repo registry (docs/tauri-architecture.md §6): the user's own local clones,
// `{ path, owner, repo }` each, persisted through the app storage (Tauri Store in the
// desktop, localStorage in browser dev). On-disk JSON is a boundary — parse-don't-trust on
// every read; unparseable data degrades to an empty list rather than crashing the home screen.

export async function loadRepoLinks(store: KeyValueStore): Promise<RepoLink[]> {
  const raw = await store.get(REPO_LINKS_KEY)
  if (raw === null) return []

  try {
    const parsed = repoLinksSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

async function saveRepoLinks(store: KeyValueStore, links: RepoLink[]): Promise<void> {
  await store.set(REPO_LINKS_KEY, JSON.stringify(links))
}

// Add (or update) a link. One link per repo slug: re-linking `acme/web` to a new folder
// replaces the old entry instead of accumulating stale paths.
export async function addRepoLink(store: KeyValueStore, link: RepoLink): Promise<RepoLink[]> {
  const existing = await loadRepoLinks(store)
  const others = existing.filter(
    (entry) => !(entry.owner === link.owner && entry.repo === link.repo)
  )

  const next = [...others, link]
  await saveRepoLinks(store, next)
  return next
}

export async function removeRepoLink(store: KeyValueStore, repo: RepoRef): Promise<RepoLink[]> {
  const existing = await loadRepoLinks(store)
  const next = existing.filter((entry) => !(entry.owner === repo.owner && entry.repo === repo.repo))

  await saveRepoLinks(store, next)
  return next
}

// The link for a PR's repo, if the user registered one. Case-insensitive: GitHub slugs are
// case-insensitive, and the origin URL's casing may differ from the PR target's.
export function findRepoLink(links: RepoLink[], repo: RepoRef): RepoLink | null {
  const owner = repo.owner.toLowerCase()
  const name = repo.repo.toLowerCase()

  return (
    links.find((link) => link.owner.toLowerCase() === owner && link.repo.toLowerCase() === name) ??
    null
  )
}
