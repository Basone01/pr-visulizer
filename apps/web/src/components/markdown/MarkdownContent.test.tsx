import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { MarkdownContent } from "./MarkdownContent"

// The markdown wrapper is the app's ONLY renderer of untrusted PR content, and it runs inside a
// privileged webview — so most of what is asserted here is what must NOT reach the DOM.

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("@/utils/externalLink/openExternal", () => ({ openExternalUrl }))

beforeEach(() => {
  openExternalUrl.mockClear()
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
})
