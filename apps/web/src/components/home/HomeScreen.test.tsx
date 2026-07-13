import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import type { PrTarget } from "@/entity/pr"
import type { RepoLink } from "@/entity/repoSource"

import { addRepoLink } from "@/tauri/repoLinks"

import { HomeScreen } from "./HomeScreen"

// The repo-first home screen ("My repos", docs/tauri-architecture.md §5): a linked local
// repo renders as a card — name, slug, path — listing its open PRs from the fixture client,
// and clicking a PR hands the review target up to the app. These tests supersede the old
// slug-only watched-repos tests (that feature is replaced, pre-release, no migration).
vi.mock("@/service/clientFactory", async () => {
  const { createFixturePrClient } = await import("@/service/fixture/fixturePrClient")
  const client = createFixturePrClient()

  return {
    getPrClient: () => client,
    getAppStorage: () => {
      throw new Error("the home-screen test injects its own store")
    },
  }
})

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe("HomeScreen — My repos", () => {
  it("renders a linked repo card (name, slug, path) with its open PRs and opens one on click", async () => {
    // Arrange
    const user = userEvent.setup()
    const store = createMemoryKeyValueStore()
    // The web fixture PR #42 lives in acme/webapp (docs/architecture.md §7 worked example).
    const webappLink: RepoLink = { path: "/Users/dev/src/webapp", owner: "acme", repo: "webapp" }
    await addRepoLink(store, webappLink)
    const onOpenTarget = vi.fn<(target: PrTarget) => void>()
    const expectedTarget: PrTarget = { owner: "acme", repo: "webapp", number: 42 }
    renderWithQuery(<HomeScreen onOpenTarget={onOpenTarget} store={store} />)

    // Act
    const prRow = await screen.findByRole("button", { name: /Add login rate limiting/ })

    // Assert — the card carries the repo name, slug and local path.
    expect(screen.getByText("webapp")).toBeInTheDocument()
    expect(screen.getByText("acme/webapp")).toBeInTheDocument()
    expect(screen.getByText(webappLink.path)).toBeInTheDocument()

    // Act — clicking the PR opens the review target.
    await user.click(prRow)

    // Assert
    expect(onOpenTarget).toHaveBeenCalledWith(expectedTarget)
  })

  it("removes a linked repo from the list", async () => {
    // Arrange
    const user = userEvent.setup()
    const store = createMemoryKeyValueStore()
    const webappLink: RepoLink = { path: "/Users/dev/src/webapp", owner: "acme", repo: "webapp" }
    await addRepoLink(store, webappLink)
    renderWithQuery(<HomeScreen onOpenTarget={() => {}} store={store} />)
    await screen.findByText("acme/webapp")

    // Act
    await user.click(screen.getByRole("button", { name: "Remove the acme/webapp link" }))

    // Assert
    expect(screen.queryByText("acme/webapp")).toBeNull()
    expect(await screen.findByText(/No repos linked yet/)).toBeInTheDocument()
  })

  it("shows the three accepted forms for an unparseable URL", async () => {
    // Arrange
    const user = userEvent.setup()
    const store = createMemoryKeyValueStore()
    const onOpenTarget = vi.fn<(target: PrTarget) => void>()
    renderWithQuery(<HomeScreen onOpenTarget={onOpenTarget} store={store} />)

    // Act
    await user.type(screen.getByLabelText("PR URL"), "not a pr")

    // Assert
    expect(screen.getByText("owner/repo#42")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled()
  })
})
