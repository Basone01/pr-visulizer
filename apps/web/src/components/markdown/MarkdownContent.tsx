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
  fileReferences?: ReadonlyArray<MarkdownFileReference>
  onOpenFile?: (reference: MarkdownFileReference) => void
}

export type MarkdownFileReference = {
  path: string
  line?: number | undefined
}

type LinkProps = {
  href?: string | undefined
  children?: ReactNode
}

type ImageProps = {
  src?: string | undefined
  alt?: string | undefined
}

const FILE_REFERENCE_PROTOCOL = "pr-file:"

function fileReferenceUrl(reference: MarkdownFileReference): string {
  const search = reference.line ? `?line=${reference.line}` : ""
  return `${FILE_REFERENCE_PROTOCOL}${encodeURIComponent(reference.path)}${search}`
}

function parseFileReferenceUrl(href: string): MarkdownFileReference | null {
  if (!href.startsWith(FILE_REFERENCE_PROTOCOL)) return null

  const value = href.slice(FILE_REFERENCE_PROTOCOL.length)
  const [encodedPath, search = ""] = value.split("?", 2)
  if (!encodedPath) return null

  try {
    const path = decodeURIComponent(encodedPath)
    const lineValue = new URLSearchParams(search).get("line")
    const line = lineValue === null ? undefined : Number(lineValue)
    if (!path || (line !== undefined && (!Number.isInteger(line) || line < 1))) return null

    return { path, ...(line === undefined ? {} : { line }) }
  } catch {
    return null
  }
}

function fileMentionPattern(references: ReadonlyArray<MarkdownFileReference>): RegExp | null {
  if (references.length === 0) return null

  const paths = [...new Set(references.map((reference) => reference.path))]
    .sort((left, right) => right.length - left.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))

  return new RegExp(
    `(^|[^A-Za-z0-9_./-])(${paths.join("|")})(?::([1-9]\\d*))?(?=$|[^A-Za-z0-9_./-]|\\.(?![A-Za-z0-9_-]))`,
    "g"
  )
}

type MarkdownAstNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownAstNode[]
}

function createFileMentionPlugin(references: ReadonlyArray<MarkdownFileReference>) {
  const pattern = fileMentionPattern(references)
  if (!pattern) return () => () => {}

  const mentionPattern = pattern

  return () => (tree: MarkdownAstNode) => {
    function transform(node: MarkdownAstNode): void {
      if (
        !node.children ||
        node.type === "link" ||
        node.type === "linkReference" ||
        node.type === "image" ||
        node.type === "imageReference" ||
        node.type === "code"
      ) {
        return
      }

      node.children = node.children.flatMap((child) => {
        if (child.type === "inlineCode" && child.value) {
          const reference = referenceForMention(child.value, references)
          if (!reference) return child

          return {
            type: "link",
            url: fileReferenceUrl(reference),
            children: [child],
          }
        }

        if (child.type !== "text" || !child.value) {
          transform(child)
          return child
        }

        const parts: MarkdownAstNode[] = []
        let index = 0
        mentionPattern.lastIndex = 0
        let match = mentionPattern.exec(child.value)
        while (match) {
          const text = match[0] ?? ""
          const prefix = match[1] ?? ""
          const path = match[2]
          const line = match[3]
          if (!path) break

          const mentionIndex = match.index + prefix.length
          const before = child.value.slice(index, mentionIndex)
          if (before) parts.push({ type: "text", value: before })

          const reference = { path, ...(line ? { line: Number(line) } : {}) }
          parts.push({
            type: "link",
            url: fileReferenceUrl(reference),
            children: [{ type: "text", value: `${path}${line ? `:${line}` : ""}` }],
          })
          index = match.index + text.length
          match = mentionPattern.exec(child.value)
        }

        const after = child.value.slice(index)
        if (after) parts.push({ type: "text", value: after })
        return parts.length > 0 ? parts : child
      })
    }

    transform(tree)
  }
}

function referenceForMention(
  value: string,
  references: ReadonlyArray<MarkdownFileReference>
): MarkdownFileReference | null {
  const match = references
    .slice()
    .sort((left, right) => right.path.length - left.path.length)
    .find(
      (reference) =>
        value === reference.path ||
        new RegExp(`^${reference.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([1-9]\\d*)$`).test(
          value
        )
    )
  if (!match) return null

  const lineMatch = /:([1-9]\d*)$/.exec(value)
  return {
    path: match.path,
    ...(lineMatch ? { line: Number(lineMatch[1]) } : {}),
    ...(!lineMatch && match.line ? { line: match.line } : {}),
  }
}

function referenceForHref(
  href: string,
  references: ReadonlyArray<MarkdownFileReference>
): MarkdownFileReference | null {
  const appReference = parseFileReferenceUrl(href)
  if (appReference) {
    const matchingReference = references.find((reference) => reference.path === appReference.path)
    return {
      ...appReference,
      ...(appReference.line === undefined && matchingReference?.line
        ? { line: matchingReference.line }
        : {}),
    }
  }

  let decodedHref: string
  try {
    decodedHref = decodeURIComponent(href)
  } catch {
    return null
  }
  const matchingReference = references
    .slice()
    .sort((left, right) => right.path.length - left.path.length)
    .find((reference) => {
      const suffix = decodedHref.slice(reference.path.length)
      return (
        decodedHref.startsWith(reference.path) &&
        (suffix === "" || /^:[1-9]\d*$/.test(suffix) || /^#L[1-9]\d*$/.test(suffix))
      )
    })
  if (!matchingReference) return null

  const lineMatch = /(?::|#L)([1-9]\d*)$/.exec(decodedHref)
  return {
    path: matchingReference.path,
    ...(lineMatch ? { line: Number(lineMatch[1]) } : {}),
    ...(!lineMatch && matchingReference.line ? { line: matchingReference.line } : {}),
  }
}

function createComponents(
  references: ReadonlyArray<MarkdownFileReference>,
  onOpenFile?: (reference: MarkdownFileReference) => void
) {
  const allowedPaths = new Set(references.map((reference) => reference.path))

  function MarkdownLink({ href, children }: LinkProps): ReactElement {
    const fileReference = href ? referenceForHref(href, references) : null
    if (fileReference && allowedPaths.has(fileReference.path) && onOpenFile) {
      return (
        <button type="button" className={styles.fileLink} onClick={() => onOpenFile(fileReference)}>
          {children}
        </button>
      )
    }

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

  return {
    a: MarkdownLink,
    img: MarkdownImage,
  }
}

export function MarkdownContent({
  source,
  variant = "page",
  fileReferences = [],
  onOpenFile,
}: MarkdownContentProps): ReactElement {
  const className =
    variant === "inline" ? `${styles.markdownPreview} ${styles.inline}` : styles.markdownPreview

  const components = createComponents(fileReferences, onOpenFile)
  const fileMentionPlugin = createFileMentionPlugin(fileReferences)

  return (
    <div className={className}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, fileMentionPlugin]}
        // Belt to the components' braces: the policy runs on every url attribute react-markdown
        // knows about (src, href, srcSet, …), so an element we did NOT override still gets it.
        urlTransform={(url, _key, node) => {
          if (referenceForHref(url, fileReferences)) return url

          return node.tagName === "img" ? safeMarkdownImageUrl(url) : safeMarkdownLinkUrl(url)
        }}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
