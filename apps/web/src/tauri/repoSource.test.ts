import { languageForPath } from "@pr-visulizer/engine"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"
import type { RepoLink } from "@/entity/repoSource"

import { chooseRepoSource, createGitRevReader } from "./repoSource"

// The git-object reader invokes Rust commands through @tauri-apps/api/core; a hoisted mock
// stands in for the invoke so the mapping (status + language) and the diff args are testable
// without Tauri.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

// The selection rule (docs/tauri-architecture.md §6): linked repo for the PR's owner/repo
// when registered, else the managed clone when a clone root exists, else nothing (the
// caller surfaces the locate-vs-clone prompt).

const acmeWebTarget: PrTarget = { owner: "acme", repo: "web", number: 42 }

describe("chooseRepoSource", () => {
  it("prefers the linked repo registered for the PR's owner/repo", () => {
    // Arrange
    const acmeWebLink: RepoLink = { path: "/Users/dev/src/web", owner: "acme", repo: "web" }
    const otherLink: RepoLink = { path: "/Users/dev/src/mobile", owner: "acme", repo: "mobile" }
    const links = [otherLink, acmeWebLink]
    const cloneRoot = "/tmp/pr-clones"

    // Act
    const choice = chooseRepoSource(links, cloneRoot, acmeWebTarget)

    // Assert
    const expected = { kind: "linked", link: acmeWebLink }
    expect(choice).toEqual(expected)
  })

  it("falls back to the managed clone when no link matches but a clone root is set", () => {
    // Arrange
    const links: RepoLink[] = [{ path: "/src/mobile", owner: "acme", repo: "mobile" }]
    const cloneRoot = "/tmp/pr-clones"

    // Act
    const choice = chooseRepoSource(links, cloneRoot, acmeWebTarget)

    // Assert
    const expected = { kind: "managed", cloneRoot }
    expect(choice).toEqual(expected)
  })

  it("chooses nothing when there is neither a link nor a clone root", () => {
    // Arrange
    const links: RepoLink[] = []
    const cloneRoot = null

    // Act
    const choice = chooseRepoSource(links, cloneRoot, acmeWebTarget)

    // Assert
    expect(choice).toEqual({ kind: "none" })
  })
})

describe("createGitRevReader — local diff over base...head", () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it("maps repo_changed_files rows to ChangedFile with status + language", async () => {
    // Arrange
    const rows = [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }]
    invokeMock.mockResolvedValueOnce(rows)
    const reader = createGitRevReader("/repo", "base1234", "head5678", true)

    // Act
    const changed = await reader.listChangedFiles()

    // Assert
    const expected = [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        language: languageForPath("src/a.ts"),
      },
    ]
    expect(invokeMock).toHaveBeenCalledWith("repo_changed_files", {
      root: "/repo",
      baseRev: "base1234",
      headRev: "head5678",
    })
    expect(changed).toEqual(expected)
  })

  it("reads a single file's diff with the pinned base + head revs", async () => {
    // Arrange
    const patch = "@@ -1 +1 @@\n-a\n+b\n"
    invokeMock.mockResolvedValueOnce(patch)
    const reader = createGitRevReader("/repo", "base1234", "head5678", true)
    const path = "src/a.ts"

    // Act
    const diff = await reader.readFileDiff(path)

    // Assert
    expect(invokeMock).toHaveBeenCalledWith("repo_file_diff", {
      root: "/repo",
      baseRev: "base1234",
      headRev: "head5678",
      path,
    })
    expect(diff).toBe(patch)
  })
})
