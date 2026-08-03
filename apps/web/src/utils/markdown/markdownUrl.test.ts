import { describe, expect, it } from "vitest"

import { safeMarkdownImageUrl, safeMarkdownLinkUrl } from "./markdownUrl"

// The URL allowlist behind the markdown preview. Empty string = rejected, which the renderer
// reads as "no URL" and degrades to plain text.

describe("safeMarkdownLinkUrl", () => {
  it("keeps https, http and mailto links", () => {
    // Arrange
    const httpsUrl = "https://example.com/a?b=1#c"
    const httpUrl = "http://example.com/old"
    const mailtoUrl = "mailto:reviewer@example.com"

    // Act
    const results = [
      safeMarkdownLinkUrl(httpsUrl),
      safeMarkdownLinkUrl(httpUrl),
      safeMarkdownLinkUrl(mailtoUrl),
    ]

    // Assert
    const expected = [httpsUrl, httpUrl, mailtoUrl]
    expect(results).toEqual(expected)
  })

  it("rejects script-bearing and file-reading protocols", () => {
    // Arrange — the leading whitespace matters: a browser trims it before resolving, so a naive
    // `startsWith("javascript:")` check would pass this straight through.
    const javascriptUrl = "javascript:alert(1)"
    const paddedJavascriptUrl = "   javascript:alert(1)"
    const uppercaseJavascriptUrl = "JavaScript:alert(1)"
    const dataUrl = "data:text/html;base64,PHNjcmlwdD4="
    const fileUrl = "file:///etc/passwd"

    // Act
    const results = [
      safeMarkdownLinkUrl(javascriptUrl),
      safeMarkdownLinkUrl(paddedJavascriptUrl),
      safeMarkdownLinkUrl(uppercaseJavascriptUrl),
      safeMarkdownLinkUrl(dataUrl),
      safeMarkdownLinkUrl(fileUrl),
    ]

    // Assert
    const expected = ["", "", "", "", ""]
    expect(results).toEqual(expected)
  })

  it("rejects relative paths and bare fragments, which cannot resolve in this app", () => {
    // Arrange — `#section` would collide with the SPA's hash routing; `./CONTRIBUTING.md`
    // would resolve against the app's own origin, not the repo.
    const relativePath = "./CONTRIBUTING.md"
    const fragment = "#installation"

    // Act
    const results = [safeMarkdownLinkUrl(relativePath), safeMarkdownLinkUrl(fragment)]

    // Assert
    const expected = ["", ""]
    expect(results).toEqual(expected)
  })
})

describe("safeMarkdownImageUrl", () => {
  it("keeps an https image", () => {
    // Arrange
    const httpsUrl = "https://img.example.com/badge.svg"

    // Act
    const result = safeMarkdownImageUrl(httpsUrl)

    // Assert
    const expected = httpsUrl
    expect(result).toBe(expected)
  })

  it("rejects everything the webview would fetch insecurely or cannot resolve", () => {
    // Arrange — images are loaded by the webview itself, with no click and no OS handoff, so
    // the allowlist here is tighter than the one for links.
    const httpUrl = "http://img.example.com/badge.svg"
    const relativePath = "./docs/arch.png"
    const dataUrl = "data:image/svg+xml,<svg onload='alert(1)'/>"

    // Act
    const results = [
      safeMarkdownImageUrl(httpUrl),
      safeMarkdownImageUrl(relativePath),
      safeMarkdownImageUrl(dataUrl),
    ]

    // Assert
    const expected = ["", "", ""]
    expect(results).toEqual(expected)
  })
})
