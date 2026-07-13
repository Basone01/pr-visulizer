import { useQuery } from "@tanstack/react-query"

import { ApiError } from "@/utils/api/http"
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

  // The gateway already sorts, but sort defensively so the newest-updated PR is always first.
  const pulls = [...(query.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const countLabel =
    query.data === undefined ? "" : `${pulls.length} open PR${pulls.length === 1 ? "" : "s"}`

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

    if (pulls.length === 0) return <div className={styles.stateRow}>No open PRs.</div>

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
