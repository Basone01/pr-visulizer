import type { PrTarget } from "@/entity/pr"

// The review deep-link lives in the URL query (docs/tauri-architecture.md §5): App reads it
// at mount, the desktop CLI bootstrap writes it before mount, and the review screen mirrors
// the open PR back so it stays shareable/refreshable. One module owns the param shape so
// the two writers (App, bootstrap) can never drift.
const OWNER = "owner"
const REPO = "repo"
const NUMBER = "number"
// A raw CLI arg that didn't parse is carried here to prefill the home input as a hint (§5).
const PREFILL = "pr"

export function readTargetFromUrl(): PrTarget | null {
  const params = new URLSearchParams(window.location.search)
  const owner = params.get(OWNER)
  const repo = params.get(REPO)
  const number = Number(params.get(NUMBER))

  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null

  return { owner, repo, number }
}

export function writeTargetToUrl(target: PrTarget | null): void {
  const url = new URL(window.location.href)

  if (target) {
    url.searchParams.set(OWNER, target.owner)
    url.searchParams.set(REPO, target.repo)
    url.searchParams.set(NUMBER, String(target.number))
    url.searchParams.delete(PREFILL)
  } else {
    url.searchParams.delete(OWNER)
    url.searchParams.delete(REPO)
    url.searchParams.delete(NUMBER)
  }

  window.history.replaceState(null, "", url)
}

export function readPrefillFromUrl(): string {
  return new URLSearchParams(window.location.search).get(PREFILL) ?? ""
}

export function writePrefillToUrl(raw: string): void {
  const url = new URL(window.location.href)
  url.searchParams.set(PREFILL, raw)
  window.history.replaceState(null, "", url)
}
