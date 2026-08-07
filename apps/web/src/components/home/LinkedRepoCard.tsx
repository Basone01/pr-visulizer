import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { ApiError } from "@/utils/api/http"
import { RECENT_PULLS_LIMIT, visiblePullRequests } from "@/utils/pulls/searchPullRequests"
import { formatRelativeTime } from "@/utils/time/relativeTime"

import type { PrTarget, RepoRef } from "@/entity/pr"
import { repoKey } from "@/entity/pr"
import type { RepoLink } from "@/entity/repoSource"

import { openPullRequestsQueryOptions } from "@/service/queries"

import styles from "./HomeScreen.module.css"

// One linked local repo and its open PRs ("My repos", docs/tauri-architecture.md §5):
// repo name, slug + local path, the open-PR picker (newest-updated first), a manual
// refresh, and remove-link. Clicking a PR opens the review screen — which reads from
// THIS local clone (the whole point of linking).

function accessError(error: unknown, repo: RepoRef): string | null {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return `Can't list ${repoKey(repo)} — token lacks access (${error.status}).`
  }

  return null
}

export function LinkedRepoCard({
  link,
  onOpenTarget,
  onRemove,
}: {
  link: RepoLink
  onOpenTarget: (target: PrTarget) => void
  onRemove: (repo: RepoRef) => void
}) {
  const repo: RepoRef = { owner: link.owner, repo: link.repo }
  const query = useQuery(openPullRequestsQueryOptions(repo))

  // Search text is per-card and deliberately NOT persisted: it is a way to reach one PR now, not
  // a preference. Each card keeps its own, so typing in one repo never filters another.
  const [search, setSearch] = useState("")

  const allPulls = query.data ?? []
  // Sorting, the recent-only cap and the search all live in the pure helper (§5).
  const pulls = visiblePullRequests(allPulls, search)

  // The count names the WHOLE set, not the visible slice — "5 of 23" is what tells the reviewer
  // the card is showing a window, and why a search can turn up something new.
  const countLabel =
    query.data === undefined
      ? ""
      : allPulls.length > pulls.length
        ? `${pulls.length} of ${allPulls.length} open PRs`
        : `${allPulls.length} open PR${allPulls.length === 1 ? "" : "s"}`

  return (
    <div className={styles.repo}>
      <div className={styles.repoHead}>
        <div className={styles.repoTitle}>
          <span className={styles.repoName}>{link.repo}</span>
          <span className={`${styles.repoSlug} mono`}>{repoKey(repo)}</span>
        </div>
        <span className={styles.repoCount}>{countLabel}</span>
        <button
          className={styles.iconBtn}
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          title="Refresh open PRs"
          aria-label="Refresh open PRs"
        >
          ↻
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => onRemove(repo)}
          title={`Remove the ${repoKey(repo)} link`}
          aria-label={`Remove the ${repoKey(repo)} link`}
        >
          ✕
        </button>
      </div>

      <div className={`${styles.repoPath} mono`} title={link.path}>
        {link.path}
      </div>

      {/* Only worth showing once there is more than the card can list — on a repo with two open
          PRs a search box is furniture. */}
      {allPulls.length > RECENT_PULLS_LIMIT && (
        <input
          className={styles.search}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${allPulls.length} open PRs by title or number`}
          aria-label={`Search open PRs in ${repoKey(repo)}`}
        />
      )}

      {renderBody()}
    </div>
  )

  function renderBody() {
    const errorMessage = accessError(query.error, repo)
    if (errorMessage) return <div className={styles.errorRow}>{errorMessage}</div>

    if (query.error) {
      return <div className={styles.errorRow}>Failed to load open PRs.</div>
    }

    if (query.isPending) return <div className={styles.stateRow}>Loading open PRs…</div>

    if (allPulls.length === 0) return <div className={styles.stateRow}>No open PRs.</div>

    // A search that matches nothing is a different answer from a repo with nothing open.
    if (pulls.length === 0) {
      return <div className={styles.stateRow}>No open PR matches “{search.trim()}”.</div>
    }

    return (
      <ul className={styles.prList}>
        {pulls.map((pull) => (
          <li key={pull.number}>
            <button
              className={styles.prRow}
              onClick={() =>
                onOpenTarget({ owner: link.owner, repo: link.repo, number: pull.number })
              }
            >
              <span className={`${styles.prNumber} mono`}>#{pull.number}</span>
              <span className={styles.prTitle}>{pull.title}</span>
              <span className={styles.prMeta}>
                {pull.author} · {formatRelativeTime(pull.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }
}
