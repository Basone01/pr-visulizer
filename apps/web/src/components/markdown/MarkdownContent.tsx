import type { ReactElement, ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { openExternalUrl } from "@/utils/externalLink/openExternal"
import { safeMarkdownImageUrl, safeMarkdownLinkUrl } from "@/utils/markdown/markdownUrl"

import styles from "./MarkdownContent.module.css"

// The ONLY module in the app that imports a markdown renderer (external-library rule): every call
// site depends on <MarkdownContent source={...} />, so the library — and the security policy
// wrapped around it — is swappable in one place.
//
// Renderer: react-markdown 10.1.0 + remark-gfm 4.0.1. Chosen over marked/markdown-it + DOMPurify
// because it builds React elements directly and never touches `innerHTML`/`dangerouslySetInnerHTML`
// — so there is no HTML string for a sanitizer to have to get right, and `a`/`img` are overridable
// components rather than markup we'd post-process.
//
// Three guarantees this file is responsible for, all covered by MarkdownContent.test.tsx:
//   1. NO raw HTML. `skipHtml` drops every inline-HTML node, so a `<script>` or an
//      `<img onerror=…>` in the PR's markdown is removed rather than parsed. rehype-raw is
//      deliberately NOT installed.
//   2. NO webview navigation. Links open through openExternalUrl (the OS browser / Tauri opener),
//      never by following an href — the desktop shell's webview must stay on the app.
//   3. NO surprise URLs. `javascript:` and friends are stripped by the url policy before render.

type MarkdownContentProps = {
  source: string
  // "page" (default) — the padded full-file preview surface. "inline" — no outer padding, for
  // embedding a body inside another card (an existing-comment thread). Same renderer + same
  // sanitization either way; only the container padding differs.
  variant?: "page" | "inline"
}

type LinkProps = {
  href?: string | undefined
  children?: ReactNode
}

type ImageProps = {
  src?: string | undefined
  alt?: string | undefined
}

function MarkdownLink({ href, children }: LinkProps): ReactElement {
  const url = href ? safeMarkdownLinkUrl(href) : ""

  // A rejected URL loses its anchor entirely rather than becoming a dead link — the reviewer
  // still reads the text, and nothing looks clickable that isn't.
  if (!url) return <span>{children}</span>

  async function open(): Promise<void> {
    await openExternalUrl(url)
  }

  return (
    <a
      className={styles.link}
      href={url}
      // The href stays on the element for hover/copy-link, but the click never follows it: in the
      // Tauri shell a real navigation would replace the app itself.
      onClick={(event) => {
        event.preventDefault()
        void open()
      }}
    >
      {children}
    </a>
  )
}

function MarkdownImage({ src, alt }: ImageProps): ReactElement {
  const url = src ? safeMarkdownImageUrl(src) : ""

  // A relative path (`./docs/diagram.png`) is the common case and it CANNOT work: the app serves
  // no repo assets, so emitting the img would fire a request at the SPA's own origin and paint a
  // broken icon. Show what the author described instead.
  if (!url) return <span className={styles.imagePlaceholder}>🖼 {alt || "image"}</span>

  return <img className={styles.image} src={url} alt={alt ?? ""} loading="lazy" />
}

const COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
}

export function MarkdownContent({ source, variant = "page" }: MarkdownContentProps): ReactElement {
  const className =
    variant === "inline" ? `${styles.markdownPreview} ${styles.inline}` : styles.markdownPreview

  return (
    <div className={className}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        // Belt to the components' braces: the policy runs on every url attribute react-markdown
        // knows about (src, href, srcSet, …), so an element we did NOT override still gets it.
        urlTransform={(url, _key, node) =>
          node.tagName === "img" ? safeMarkdownImageUrl(url) : safeMarkdownLinkUrl(url)
        }
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
