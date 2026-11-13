import type { ReactElement, ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { openExternalUrl } from "@/utils/externalLink/openExternal"
import {
  linkTargetHost,
  safeHttpsLinkUrl,
  safeMarkdownImageUrl,
  safeMarkdownLinkUrl,
} from "@/utils/markdown/markdownUrl"
import { stripBidiControls } from "@/utils/text/bidiControls"

import styles from "./MarkdownContent.module.css"
import { MermaidDiagram } from "./MermaidDiagram"

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
//   1. NO unsanitized HTML. By default `skipHtml` drops every inline-HTML node, so a `<script>`
//      or an `<img onerror=…>` is removed rather than parsed. The answer window opts into raw HTML
//      with html="sanitized", which runs it through rehype-sanitize's GitHub schema in the same
//      hast tree, so there is still no innerHTML.
//   2. NO webview navigation. Links open through openExternalUrl (the OS browser / Tauri opener),
//      never by following an href — the desktop shell's webview must stay on the app.
//   3. NO surprise URLs. `javascript:` and friends are stripped by the url policy before render.
//
// One contained exception to "never touches innerHTML": a ```mermaid fence renders through
// MermaidDiagram, which attaches the SVG mermaid builds (securityLevel "strict", so labels are
// HTML-encoded and click bindings are off). That component is the only place it happens.

type MarkdownContentProps = {
  source: string
  // "strip" (default) drops inline HTML. "sanitized" renders it through the GitHub schema below.
  html?: "strip" | "sanitized"
  // "page" (default) — the padded full-file preview surface. "inline" — no outer padding, for
  // embedding a body inside another card (an existing-comment thread). Same renderer + same
  // sanitization either way; only the container padding differs.
  variant?: "page" | "inline"
  fileReferences?: ReadonlyArray<MarkdownFileReference>
  onOpenFile?: (reference: MarkdownFileReference) => void
  // "default" — the policy every PR preview has always had. "strict" — for text an agent wrote,
  // which a PR can steer: no image loads, a mermaid fence stays a code block, and a link opens
  // only when it is https. Both modes still need a click to open a link.
  urlPolicy?: MarkdownUrlPolicy
}

type MarkdownUrlPolicy = "default" | "strict"

export type MarkdownFileReference = {
  path: string
  line?: number | undefined
}

type LinkProps = {
  href?: string | undefined
  children?: ReactNode
}

type PreProps = {
  node?: MarkdownHastNode | undefined
  children?: ReactNode
}

// The slice of a hast element `pre` needs: a fence is <pre><code class="language-x">text</code>.
type MarkdownHastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: MarkdownHastNode[]
}

type ImageProps = {
  src?: string | undefined
  alt?: string | undefined
}

const FILE_REFERENCE_SCHEME = "pr-file"
const FILE_REFERENCE_PROTOCOL = `${FILE_REFERENCE_SCHEME}:`

// GitHub's schema, plus the pr-file: protocol, because the file-mention plugin emits links with it
// and the sanitizer would otherwise drop their href.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), FILE_REFERENCE_SCHEME],
  },
}

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

// Under "strict" the text of every link loses its bidi controls, which could otherwise make the
// label read differently from what it is. Nested text (**bold**, `code`) is included.
function createLinkBidiPlugin(urlPolicy: MarkdownUrlPolicy) {
  if (urlPolicy !== "strict") return () => () => {}

  function stripText(node: MarkdownAstNode): void {
    if (node.value !== undefined) node.value = stripBidiControls(node.value)
    node.children?.forEach(stripText)
  }

  function findLinks(node: MarkdownAstNode): void {
    if (node.type === "link") {
      node.children?.forEach(stripText)
      return
    }

    node.children?.forEach(findLinks)
  }

  return () => findLinks
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

function mermaidFenceSource(pre: MarkdownHastNode): string | null {
  const code = pre.children?.find((child) => child.type === "element")
  const className = code?.properties?.className
  const isMermaid =
    code?.tagName === "code" && Array.isArray(className) && className.includes("language-mermaid")
  if (!isMermaid) return null

  return (code.children ?? []).map((child) => child.value ?? "").join("")
}

function createComponents(
  references: ReadonlyArray<MarkdownFileReference>,
  urlPolicy: MarkdownUrlPolicy,
  onOpenFile?: (reference: MarkdownFileReference) => void
) {
  const isStrict = urlPolicy === "strict"
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

    const url = href ? linkUrlFor(href, urlPolicy) : ""

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
        // A webview has no status bar, so under "strict" the full target is the title.
        title={isStrict ? url : undefined}
        // The href stays on the element for hover/copy-link, but the click never follows it: in the
        // Tauri shell a real navigation would replace the app itself.
        onClick={(event) => {
          event.preventDefault()
          void open()
        }}
      >
        {children}
        {/* Link text an agent wrote can look like a file reference, so the host is always shown,
            isolated so nothing before it can reorder it. */}
        {isStrict && (
          <>
            {" "}
            <bdi dir="ltr" className={styles.linkTarget}>
              ({linkTargetHost(url)})
            </bdi>
          </>
        )}
      </a>
    )
  }

  function MarkdownImage({ src, alt }: ImageProps): ReactElement {
    const url = src ? imageUrlFor(src, urlPolicy) : ""

    // A relative path (`./docs/diagram.png`) is the common case and it CANNOT work: the app serves
    // no repo assets, so emitting the img would fire a request at the SPA's own origin and paint a
    // broken icon. Show what the author described instead.
    if (!url) return <span className={styles.imagePlaceholder}>🖼 {alt || "image"}</span>

    return <img className={styles.image} src={url} alt={alt ?? ""} loading="lazy" />
  }

  // Overridden at `pre`, not `code`: a diagram must replace the whole fenced block, not render
  // inside a monospace <pre>.
  function MarkdownPre({ node, children }: PreProps): ReactElement {
    // Under "strict" mermaid never runs: it parses YAML and lays out on its own, so a diagram can
    // make the webview fetch a URL, and no text screen can prove otherwise. The fence stays code.
    const mermaidSource = node && !isStrict ? mermaidFenceSource(node) : null
    if (mermaidSource !== null) return <MermaidDiagram source={mermaidSource} />

    return <pre>{children}</pre>
  }

  return {
    a: MarkdownLink,
    img: MarkdownImage,
    pre: MarkdownPre,
  }
}

// An image the webview would fetch on its own is never allowed under "strict".
function imageUrlFor(url: string, urlPolicy: MarkdownUrlPolicy): string {
  return urlPolicy === "strict" ? "" : safeMarkdownImageUrl(url)
}

function linkUrlFor(url: string, urlPolicy: MarkdownUrlPolicy): string {
  return urlPolicy === "strict" ? safeHttpsLinkUrl(url) : safeMarkdownLinkUrl(url)
}

export function MarkdownContent({
  source,
  html = "strip",
  variant = "page",
  fileReferences = [],
  onOpenFile,
  urlPolicy = "default",
}: MarkdownContentProps): ReactElement {
  const className =
    variant === "inline" ? `${styles.markdownPreview} ${styles.inline}` : styles.markdownPreview

  const components = createComponents(fileReferences, urlPolicy, onOpenFile)
  const fileMentionPlugin = createFileMentionPlugin(fileReferences)
  const linkBidiPlugin = createLinkBidiPlugin(urlPolicy)
  const isHtmlSanitized = html === "sanitized"

  return (
    <div className={className}>
      <ReactMarkdown
        skipHtml={!isHtmlSanitized}
        remarkPlugins={[remarkGfm, fileMentionPlugin, linkBidiPlugin]}
        rehypePlugins={isHtmlSanitized ? [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]] : []}
        // Belt to the components' braces: the policy runs on every url attribute react-markdown
        // knows about (src, href, srcSet, …), so an element we did NOT override still gets it.
        urlTransform={(url, _key, node) => {
          if (referenceForHref(url, fileReferences)) return url

          return node.tagName === "img" ? imageUrlFor(url, urlPolicy) : linkUrlFor(url, urlPolicy)
        }}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
