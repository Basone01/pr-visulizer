import type { PrMeta } from "@pr-visulizer/shared"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { PrDescriptionPanel } from "./PrDescriptionPanel"

// The description viewer renders untrusted PR markdown and offers an open-on-GitHub escape hatch.
// The markdown-safety guarantees live in MarkdownContent's own tests; here we assert the panel
// wires the body to that wrapper, handles the no-description case, routes the external link
// through the openExternalUrl seam, and closes on Escape.

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("@/utils/externalLink/openExternal", () => ({ openExternalUrl }))

const basePr: PrMeta = {
  owner: "acme",
  repo: "web",
  number: 42,
  title: "Add login rate limiting",
  author: "octocat",
  baseSha: "a1b2c3d0000",
  headSha: "3f9c2e10000",
  body: ["## Summary", "", "- token bucket", "", "[rfc](https://example.com/rfc)"].join("\n"),
  htmlUrl: "https://github.com/acme/web/pull/42",
}

beforeEach(() => {
  openExternalUrl.mockClear()
})

describe("PrDescriptionPanel", () => {
  it("renders the PR title, author and body markdown as real elements", () => {
    // Arrange
    const pr = basePr
    const onClose = vi.fn()

    // Act
    render(<PrDescriptionPanel pr={pr} onClose={onClose} />)

    // Assert
    expect(screen.getByRole("heading", { level: 2, name: pr.title })).toBeInTheDocument()
    expect(screen.getByText(/octocat/)).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "Summary" })).toBeInTheDocument()
    expect(screen.getByRole("listitem").textContent).toBe("token bucket")
  })

  it("shows a no-description empty state when body is null", () => {
    // Arrange
    const nullBody = null
    const pr: PrMeta = { ...basePr, body: nullBody }
    const onClose = vi.fn()

    // Act
    render(<PrDescriptionPanel pr={pr} onClose={onClose} />)

    // Assert
    expect(screen.getByText("No description.")).toBeInTheDocument()
    expect(screen.queryByRole("listitem")).toBeNull()
  })

  it("routes Open on GitHub through openExternalUrl with the PR's html url", async () => {
    // Arrange
    const pr = basePr
    const expectedUrl = basePr.htmlUrl
    const onClose = vi.fn()
    render(<PrDescriptionPanel pr={pr} onClose={onClose} />)

    // Act
    await userEvent.click(screen.getByRole("button", { name: /Open on GitHub/ }))

    // Assert — the app never navigates the webview itself; the OS opener gets the exact url.
    expect(openExternalUrl).toHaveBeenCalledWith(expectedUrl)
    expect(openExternalUrl).toHaveBeenCalledTimes(1)
  })

  it("hides Open on GitHub when the PR has no html url", () => {
    // Arrange
    const pr: PrMeta = { ...basePr, htmlUrl: undefined }
    const onClose = vi.fn()

    // Act
    render(<PrDescriptionPanel pr={pr} onClose={onClose} />)

    // Assert
    expect(screen.queryByRole("button", { name: /Open on GitHub/ })).toBeNull()
  })

  it("closes on Escape", async () => {
    // Arrange
    const pr = basePr
    const onClose = vi.fn()
    render(<PrDescriptionPanel pr={pr} onClose={onClose} />)

    // Act
    await userEvent.keyboard("{Escape}")

    // Assert
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes when the backdrop is clicked but not when the sheet is", async () => {
    // Arrange
    const pr = basePr
    const onClose = vi.fn()
    render(<PrDescriptionPanel pr={pr} onClose={onClose} />)

    // Act — clicking the dialog surface must NOT close; clicking the backdrop behind it must.
    await userEvent.click(screen.getByRole("dialog"))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("dialog").parentElement as HTMLElement)

    // Assert
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
