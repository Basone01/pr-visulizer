import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import type { RepoLink } from "@/entity/repoSource"

import { addRepoLink, findRepoLink, loadRepoLinks, removeRepoLink } from "./repoLinks"

describe("repo-link registry", () => {
  it("round-trips a link through the store", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const acmeWebLink: RepoLink = { path: "/Users/dev/src/web", owner: "acme", repo: "web" }

    // Act
    await addRepoLink(store, acmeWebLink)
    const loaded = await loadRepoLinks(store)

    // Assert
    const expected = [acmeWebLink]
    expect(loaded).toEqual(expected)
  })

  it("re-linking the same slug replaces the old path instead of accumulating", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const oldLink: RepoLink = { path: "/old/web", owner: "acme", repo: "web" }
    const newLink: RepoLink = { path: "/new/web", owner: "acme", repo: "web" }

    // Act
    await addRepoLink(store, oldLink)
    await addRepoLink(store, newLink)
    const loaded = await loadRepoLinks(store)

    // Assert
    const expected = [newLink]
    expect(loaded).toEqual(expected)
  })

  it("removes a link by slug", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const keptLink: RepoLink = { path: "/src/mobile", owner: "acme", repo: "mobile" }
    const removedLink: RepoLink = { path: "/src/web", owner: "acme", repo: "web" }
    await addRepoLink(store, keptLink)
    await addRepoLink(store, removedLink)

    // Act
    await removeRepoLink(store, { owner: "acme", repo: "web" })
    const loaded = await loadRepoLinks(store)

    // Assert
    const expected = [keptLink]
    expect(loaded).toEqual(expected)
  })

  it("degrades unparseable stored JSON to an empty list", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    await store.set("repoLinks", "not json at all {")

    // Act
    const loaded = await loadRepoLinks(store)

    // Assert
    expect(loaded).toEqual([])
  })

  it("finds a link case-insensitively (GitHub slugs are case-insensitive)", () => {
    // Arrange
    const links: RepoLink[] = [{ path: "/src/web", owner: "Acme", repo: "Web" }]
    const lookupRepo = { owner: "acme", repo: "web" }

    // Act
    const found = findRepoLink(links, lookupRepo)

    // Assert
    expect(found).toEqual(links[0])
  })
})
