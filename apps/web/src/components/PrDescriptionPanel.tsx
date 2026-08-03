import type { PrMeta } from "@pr-visulizer/shared"

import { openExternalUrl } from "@/utils/externalLink/openExternal"

import { useEscapeKey } from "@/hooks/useEscapeKey"

import { MarkdownContent } from "@/components/markdown/MarkdownContent"

import styles from "./PrDescriptionPanel.module.css"

// The in-app PR description viewer. github.com forbids framing (X-Frame-Options: deny +
// CSP default-src 'none'), so the requested "PR page in an iframe" cannot render — this is the
// approved substitute: the PR's meta + its description body rendered in-app, with an
// open-on-GitHub escape hatch. Purely presentational: it holds no review state, so opening or
// closing it never touches the reviewer's progress, drafts or verdict.
//
// The body is untrusted third-party markdown, so it goes through <MarkdownContent> (the single
// markdown seam — no raw HTML, links open the OS browser, unsafe URLs stripped), never a raw
// renderer. "Open on GitHub" routes through openExternalUrl, the one wrapper for leaving the app.

type PrDescriptionPanelProps = {
  pr: PrMeta
  onClose: () => void
}

function hasDescription(body: PrMeta["body"]): body is string {
  return typeof body === "string" && body.trim().length > 0
}

export function PrDescriptionPanel({ pr, onClose }: PrDescriptionPanelProps) {
  // Escape closes the sheet. It's a modal over the whole app, so it outranks every other Escape
  // consumer — the claim lives exactly as long as the panel is mounted.
  useEscapeKey("descriptionPanel", true, onClose)

  async function openOnGitHub(): Promise<void> {
    if (!pr.htmlUrl) return

    await openExternalUrl(pr.htmlUrl)
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <aside
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`Description for PR #${pr.number}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <div className={styles.eyebrow}>
              PR #{pr.number} · {pr.author}
            </div>
            <h2 className={styles.title}>{pr.title}</h2>
            <div className={`${styles.refs} mono`}>
              {pr.baseSha.slice(0, 7)} ← {pr.headSha.slice(0, 7)}
            </div>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close description">
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {hasDescription(pr.body) ? (
            <MarkdownContent source={pr.body} />
          ) : (
            <p className={styles.empty}>No description.</p>
          )}
        </div>

        {pr.htmlUrl && (
          <footer className={styles.foot}>
            <button className={styles.openExternal} onClick={() => void openOnGitHub()}>
              Open on GitHub ↗
            </button>
          </footer>
        )}
      </aside>
    </div>
  )
}
