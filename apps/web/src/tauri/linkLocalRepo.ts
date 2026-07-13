import { parseOriginUrl } from "@/utils/git/parseOriginUrl"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import type { RepoRef } from "@/entity/pr"
import type { RepoLink } from "@/entity/repoSource"

import { addRepoLink } from "./repoLinks"

// "Locate local clone…" (docs/tauri-architecture.md §6) and the home screen's "+ Add local
// repo" share this flow: pick a folder, derive its `{owner, repo}` from the origin remote
// (via the Rust `repo_origin_url` command — not a git repo / no origin surfaces as its
// error), and register the link. The outcome is a discriminated union so the UI renders
// each case — linked, cancelled, or a human-readable inline error — without string matching.

export type LinkOutcome =
  | { status: "linked"; link: RepoLink }
  | { status: "cancelled" }
  | { status: "error"; message: string }

// Open the native folder picker for a repo to link; null = cancelled.
async function pickRepoFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog")
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Locate the local clone",
  })

  return typeof selected === "string" ? selected : null
}

async function originSlugOf(path: string): Promise<RepoRef | null> {
  const { invoke } = await import("@tauri-apps/api/core")
  const originUrl = await invoke<string>("repo_origin_url", { root: path })

  return parseOriginUrl(originUrl)
}

// Link a picked folder, optionally REQUIRING it to match a PR's owner/repo (the locate
// prompt); the home screen passes no expectation and takes whatever the origin says.
export async function linkLocalRepo(
  storage: KeyValueStore,
  expected?: RepoRef
): Promise<LinkOutcome> {
  const path = await pickRepoFolder()
  if (path === null) return { status: "cancelled" }

  let slug: RepoRef | null
  try {
    slug = await originSlugOf(path)
  } catch (error) {
    // The Rust command's error covers both "not a git repo" and "no origin remote".
    const message = error instanceof Error ? error.message : String(error)
    return { status: "error", message: `Not a usable git clone — ${message}` }
  }

  if (!slug) {
    return { status: "error", message: "The folder's origin remote is not a GitHub repo" }
  }

  if (
    expected &&
    (slug.owner.toLowerCase() !== expected.owner.toLowerCase() ||
      slug.repo.toLowerCase() !== expected.repo.toLowerCase())
  ) {
    return {
      status: "error",
      message: `That clone is ${slug.owner}/${slug.repo}, not ${expected.owner}/${expected.repo}`,
    }
  }

  const link: RepoLink = { path, owner: slug.owner, repo: slug.repo }
  await addRepoLink(storage, link)
  return { status: "linked", link }
}
