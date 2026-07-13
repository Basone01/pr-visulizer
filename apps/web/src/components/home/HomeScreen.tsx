import { useState } from "react"

import { env } from "@/config/env"

import { ACCEPTED_PR_FORMS, parsePrTarget } from "@/utils/prUrl/parsePrTarget"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import type { PrTarget } from "@/entity/pr"

import { getAppStorage } from "@/service/clientFactory"

import { useRepoLinks } from "@/hooks/useRepoLinks"

import { linkLocalRepo } from "@/tauri/linkLocalRepo"

import styles from "./HomeScreen.module.css"
import { LinkedRepoCard } from "./LinkedRepoCard"

// The home screen — repo-first ("My repos", docs/tauri-architecture.md §5): the user's
// linked local repos, each card listing its open PRs. "+ Add local repo" runs the picker →
// derive owner/repo from the origin remote → register (desktop only; browser mode shows the
// list read-only). The URL paste stays on top: a pasted PR whose repo is linked reads from
// that clone; an unlinked one lands on the review screen's locate-vs-clone prompt — either
// way the target just opens, the review screen owns the rest. `store` is injectable so
// tests drive the repo list with an in-memory one.

export function HomeScreen({
  onOpenTarget,
  store,
  initialUrlText,
}: {
  onOpenTarget: (target: PrTarget) => void
  store?: KeyValueStore
  // A raw CLI arg the desktop shell couldn't parse, prefilled as a starting point (§5).
  initialUrlText?: string
}) {
  const repoLinks = useRepoLinks(store)

  const [urlText, setUrlText] = useState(initialUrlText ?? "")
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const parsedTarget = parsePrTarget(urlText)
  const showFormsHint = urlText.trim().length > 0 && parsedTarget === null

  function goToParsedTarget(): void {
    if (parsedTarget) onOpenTarget(parsedTarget)
  }

  // "+ Add local repo": folder picker → origin-derived slug → registry. Errors (not a git
  // repo, no GitHub origin) render inline under the section head.
  async function addLocalRepo(): Promise<void> {
    setAdding(true)
    setAddError(null)
    try {
      const outcome = await linkLocalRepo(store ?? getAppStorage())
      if (outcome.status === "linked") repoLinks.refresh()
      else if (outcome.status === "error") setAddError(outcome.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.container}>
        <h1 className={styles.title}>PR Review Visualizer</h1>
        <p className={styles.subtitle}>
          Open a pull request by URL, or pick one from your linked repos.
        </p>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Open a PR</span>
          </div>

          <div className={styles.inputRow}>
            <input
              className={styles.input}
              placeholder="Paste a GitHub PR URL…"
              value={urlText}
              onChange={(event) => setUrlText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") goToParsedTarget()
              }}
              aria-label="PR URL"
            />
            <button
              className={`${styles.btn} ${styles.primary}`}
              onClick={goToParsedTarget}
              disabled={parsedTarget === null}
            >
              Go
            </button>
          </div>

          {showFormsHint ? (
            <div className={styles.hint}>
              Enter one of:
              <ul className={styles.hintForms}>
                {ACCEPTED_PR_FORMS.map((form) => (
                  <li key={form} className="mono">
                    {form}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>My repos</span>
            {env.tauriMode && (
              <button className={styles.btn} onClick={() => void addLocalRepo()} disabled={adding}>
                {adding ? "Opening…" : "+ Add local repo"}
              </button>
            )}
          </div>

          {addError && (
            <p className={styles.addError} role="alert">
              {addError}
            </p>
          )}

          <div style={{ marginTop: 14 }}>
            {repoLinks.links.length === 0 ? (
              <p className={styles.empty}>
                {env.tauriMode
                  ? "No repos linked yet — add the local clone you already work in."
                  : "No repos linked yet. Linking local repos is a desktop-app feature."}
              </p>
            ) : (
              repoLinks.links.map((link) => (
                <LinkedRepoCard
                  key={`${link.owner}/${link.repo}`}
                  link={link}
                  onOpenTarget={onOpenTarget}
                  onRemove={repoLinks.remove}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
