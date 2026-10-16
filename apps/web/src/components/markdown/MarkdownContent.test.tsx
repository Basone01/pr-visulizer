import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { MarkdownContent } from "./MarkdownContent"

// The markdown wrapper is the app's ONLY renderer of untrusted PR content, and it runs inside a
// privileged webview — so most of what is asserted here is what must NOT reach the DOM.

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("@/utils/externalLink/openExternal", () => ({ openExternalUrl }))

// mermaid needs real SVG layout, which jsdom lacks — the wrapper is mocked at its module boundary.
const renderMermaidSvg = vi.hoisted(() => vi.fn<(source: string) => Promise<string>>())

vi.mock("@/utils/markdown/mermaidRenderer", () => ({ renderMermaidSvg }))

beforeEach(() => {
  openExternalUrl.mockClear()
  renderMermaidSvg.mockReset()
})

describe("MarkdownContent", () => {
  it("renders headings, lists and code blocks as real elements", () => {
    // Arrange
    const source = [
      "# Rate limiting",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const max = 5",
      "```",
    ].join("\n")

    // Act
    render(<MarkdownContent source={source} />)

    // Assert
    expect(screen.getByRole("heading", { level: 1, name: "Rate limiting" })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "first",
      "second",
    ])
    expect(document.querySelector("pre code")?.textContent).toBe("const max = 5\n")
  })

  it("renders a GFM table", () => {
    // Arrange
    const source = ["| header |", "| --- |", "| cell |"].join("\n")

    // Act
    render(<MarkdownContent source={source} />)

    // Assert
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "header" })).toBeInTheDocument()
  })

  it("strips inline HTML instead of parsing it", () => {
    // Arrange — the two classic injections: a script tag, and an event handler on a tag that
    // fires without any user interaction.
    const source = [
      "intro",
      "",
      "<script>window.__pwned = true</script>",
      "",
      '<img src="x" onerror="window.__pwned = true">',
      "",
      "outro",
    ].join("\n")

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert — no element, no leftover text, and nothing carrying the handler.
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    expect(container.textContent).not.toContain("window.__pwned")
    expect(container.textContent).toContain("intro")
    expect(container.textContent).toContain("outro")
  })

  it("neutralizes a javascript: link into plain text", () => {
    // Arrange
    const linkText = "click me"
    const source = `[${linkText}](javascript:alert(document.cookie))`

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert — the words survive, the anchor does not.
    expect(container.querySelector("a")).toBeNull()
    expect(screen.getByText(linkText)).toBeInTheDocument()
  })

  it("routes an https link click through openExternalUrl instead of navigating", async () => {
    // Arrange
    const linkText = "the docs"
    const href = "https://example.com/docs"
    const source = `[${linkText}](${href})`
    render(<MarkdownContent source={source} />)

    // Act
    const link = screen.getByRole("link", { name: linkText })
    const defaultPrevented = !link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    )

    // Assert — the click is swallowed (no webview navigation) and handed to the OS opener.
    expect(defaultPrevented).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith(href)
  })

  it("does not hand a rejected url to openExternalUrl", async () => {
    // Arrange
    const linkText = "totally safe"
    const source = `[${linkText}](javascript:alert(1))`
    render(<MarkdownContent source={source} />)

    // Act
    await userEvent.click(screen.getByText(linkText))

    // Assert
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it("opens_only_recognized_file_mentions_and_keeps_fenced_code_literal", async () => {
    // Arrange
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    const source = [
      "Plain mention: bff/.env.",
      "",
      "[Docker configuration](docker-compose.yml#L66)",
      "",
      "~~~text",
      "bff/.env:6",
      "~~~",
      "",
      "```text",
      "bff/.env:6",
      "```",
    ].join("\n")
    const fileReferences = [{ path: "bff/.env", line: 6 }, { path: "docker-compose.yml" }]
    render(
      <MarkdownContent source={source} fileReferences={fileReferences} onOpenFile={onOpenFile} />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "bff/.env" }))
    await user.click(screen.getByRole("button", { name: "Docker configuration" }))

    // Assert
    expect(onOpenFile).toHaveBeenNthCalledWith(1, { path: "bff/.env", line: 6 })
    expect(onOpenFile).toHaveBeenNthCalledWith(2, { path: "docker-compose.yml", line: 66 })
    expect(screen.getAllByText("bff/.env:6", { selector: "code" })).toHaveLength(2)
  })

  it("does_not_turn_partial_paths_or_code_inside_existing_links_into_file_buttons", () => {
    // Arrange
    const onOpenFile = vi.fn()
    const source = [
      "src/foo.ts.extra",
      "",
      "[`src/foo.ts:42`](https://example.com/docs)",
      "",
      "[malformed](https://example.com/%)",
    ].join("\n")
    render(
      <MarkdownContent
        source={source}
        fileReferences={[{ path: "src/foo.ts", line: 42 }]}
        onOpenFile={onOpenFile}
      />
    )

    // Act
    const buttons = screen.queryAllByRole("button")

    // Assert
    expect(buttons).toHaveLength(0)
    expect(screen.getByRole("link", { name: "src/foo.ts:42" })).toHaveAttribute(
      "href",
      "https://example.com/docs"
    )
  })

  it("renders an https image but replaces a relative one with its alt text", () => {
    // Arrange — a repo-relative path is the common README case and cannot resolve: the app
    // serves no repo assets, so emitting the <img> would request the SPA's own origin.
    const remoteAlt = "build badge"
    const remoteSrc = "https://img.example.com/badge.svg"
    const relativeAlt = "architecture diagram"
    const source = [`![${remoteAlt}](${remoteSrc})`, "", `![${relativeAlt}](./docs/arch.png)`].join(
      "\n"
    )

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert
    expect(screen.getByRole("img", { name: remoteAlt })).toHaveAttribute("src", remoteSrc)
    expect(container.querySelectorAll("img")).toHaveLength(1)
    expect(container.textContent).toContain(relativeAlt)
  })

  it("drops a plain-http image rather than loading it over an insecure origin", () => {
    // Arrange
    const alt = "insecure"
    const source = `![${alt}](http://img.example.com/badge.svg)`

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert
    expect(container.querySelectorAll("img")).toHaveLength(0)
    expect(container.textContent).toContain(alt)
  })

  it("renders_a_mermaid_fence_as_a_diagram", async () => {
    // Arrange
    const diagramSource = "graph TD; A-->B"
    const source = ["```mermaid", diagramSource, "```"].join("\n")
    renderMermaidSvg.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>')

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert
    expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toBeInTheDocument()
    expect(renderMermaidSvg).toHaveBeenCalledWith(`${diagramSource}\n`)
    expect(container.querySelector("pre")).toBeNull()
  })

  it("falls_back_to_the_code_block_when_mermaid_rejects_the_source", async () => {
    // Arrange
    const diagramSource = "not a diagram"
    const source = ["```mermaid", diagramSource, "```"].join("\n")
    const errorMessage = "No diagram type detected"
    renderMermaidSvg.mockRejectedValue(new Error(`${errorMessage}\nsecond line`))

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert
    expect(await screen.findByText(new RegExp(errorMessage))).toBeInTheDocument()
    expect(container.querySelector("pre code")?.textContent).toBe(`${diagramSource}\n`)
  })

  it("keeps_other_fences_as_plain_code_blocks", () => {
    // Arrange
    const source = ["```ts", "const max = 5", "```"].join("\n")

    // Act
    const { container } = render(<MarkdownContent source={source} />)

    // Assert
    expect(container.querySelector("pre code")?.className).toBe("language-ts")
    expect(renderMermaidSvg).not.toHaveBeenCalled()
  })

  it("renders_sanitized_html_when_html_is_enabled", () => {
    // Arrange
    const source = "<details><summary>More</summary>body</details>"

    // Act
    const { container } = render(<MarkdownContent source={source} html="sanitized" />)

    // Assert
    const details = container.querySelector("details")
    expect(details).not.toBeNull()
    expect(details?.querySelector("summary")).toHaveTextContent("More")
    expect(details).toHaveTextContent("body")
  })

  it("strips_scripts_and_event_handlers_even_when_html_is_enabled", () => {
    // Arrange
    const source = [
      "<script>window.pwned = true</script>",
      "",
      'Look <img src="https://example.com/a.png" onerror="window.pwned = true"> here.',
      "",
      'Then <a href="javascript:window.pwned = true">click me</a>.',
    ].join("\n")

    // Act
    const { container } = render(<MarkdownContent source={source} html="sanitized" />)

    // Assert
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(screen.getByText("click me")).toBeInTheDocument()
  })

  it("keeps_file_mention_links_clickable_when_html_is_enabled", async () => {
    // Arrange
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    const source = "Press <kbd>Enter</kbd> in src/auth.ts:18 to submit."
    const fileReferences = [{ path: "src/auth.ts" }]
    render(
      <MarkdownContent
        source={source}
        html="sanitized"
        fileReferences={fileReferences}
        onOpenFile={onOpenFile}
      />
    )

    // Act
    await user.click(screen.getByRole("button", { name: "src/auth.ts:18" }))

    // Assert
    expect(onOpenFile).toHaveBeenCalledWith({ path: "src/auth.ts", line: 18 })
  })

  it("renders_a_mermaid_fence_as_a_diagram_when_html_is_enabled", async () => {
    // Arrange
    const diagramSource = "graph TD; A-->B"
    const source = ["<sup>note</sup>", "", "```mermaid", diagramSource, "```"].join("\n")
    renderMermaidSvg.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>')

    // Act
    const { container } = render(<MarkdownContent source={source} html="sanitized" />)

    // Assert
    expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toBeInTheDocument()
    expect(renderMermaidSvg).toHaveBeenCalledWith(`${diagramSource}\n`)
    expect(container.querySelector("pre")).toBeNull()
  })
})
