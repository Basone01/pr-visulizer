import { describe, expect, it } from "vitest"

import type { PrTarget } from "@/entity/pr"

import {
  checkoutArgs,
  checkoutDir,
  checkoutFilePath,
  cloneArgs,
  fetchArgs,
  lsFilesArgs,
  ownerRepoSlug,
  parseGitProgress,
} from "./cloneManager"

// The pure arg-building parts of the clone manager (docs/tauri-architecture.md §6): the layout
// `<cloneRoot>/<owner>/<repo>` and the exact argv per fresh-vs-reuse command. These are the one
// source of truth the capability validators (§7) must accept, so they are worth pinning.

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

describe("cloneManager arg building — checkout layout", () => {
  it("lays a repo out under <cloneRoot>/<owner>/<repo>", () => {
    // Arrange
    const cloneRoot = "/Users/me/pr-clones"
    const expectedDir = "/Users/me/pr-clones/acme/web"

    // Act
    const dir = checkoutDir(cloneRoot, target)

    // Assert
    expect(dir).toBe(expectedDir)
  })

  it("normalizes a trailing slash on the picked clone root", () => {
    // Arrange
    const cloneRoot = "/Users/me/pr-clones/"
    const expectedDir = "/Users/me/pr-clones/acme/web"

    // Act
    const dir = checkoutDir(cloneRoot, target)

    // Assert
    expect(dir).toBe(expectedDir)
  })

  it("joins a repo-relative path onto the checkout dir for an fs read", () => {
    // Arrange
    const dir = "/Users/me/pr-clones/acme/web"
    const repoPath = "src/middleware/withRateLimit.ts"
    const expectedPath = "/Users/me/pr-clones/acme/web/src/middleware/withRateLimit.ts"

    // Act
    const path = checkoutFilePath(dir, repoPath)

    // Assert
    expect(path).toBe(expectedPath)
  })
})

describe("cloneManager arg building — fresh clone (dir absent)", () => {
  it("builds `gh repo clone <owner>/<repo> <dir>`", () => {
    // Arrange
    const dir = "/Users/me/pr-clones/acme/web"
    // `-- --progress` forces git progress lines for the live phase detail (no TTY in a spawn).
    const expectedArgs = ["repo", "clone", "acme/web", dir, "--", "--progress"]

    // Act
    const args = cloneArgs(target, dir)

    // Assert
    expect(ownerRepoSlug(target)).toBe("acme/web")
    expect(args).toEqual(expectedArgs)
  })
})

describe("cloneManager arg building — reuse (fetch + detached checkout)", () => {
  it("fetches the PR head ref into FETCH_HEAD", () => {
    // Arrange
    const dir = "/Users/me/pr-clones/acme/web"
    const prNumber = 42
    const expectedArgs = ["-C", dir, "fetch", "--progress", "origin", "pull/42/head"]

    // Act
    const args = fetchArgs(dir, prNumber)

    // Assert
    expect(args).toEqual(expectedArgs)
  })

  it("force-detaches onto FETCH_HEAD (our cache dir, dirty state discarded)", () => {
    // Arrange
    const dir = "/Users/me/pr-clones/acme/web"
    const expectedArgs = ["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"]

    // Act
    const args = checkoutArgs(dir)

    // Assert
    expect(args).toEqual(expectedArgs)
  })

  it("lists tracked files with `git -C <dir> ls-files`", () => {
    // Arrange
    const dir = "/Users/me/pr-clones/acme/web"
    const expectedArgs = ["-C", dir, "ls-files"]

    // Act
    const args = lsFilesArgs(dir)

    // Assert
    expect(args).toEqual(expectedArgs)
  })
})

describe("parseGitProgress — git stderr → live phase detail", () => {
  it("extracts the stage and percentage from a progress line", () => {
    // Arrange
    const progressLine = "Receiving objects:  42% (8123/19340), 12.40 MiB | 4.10 MiB/s"

    // Act
    const detail = parseGitProgress(progressLine)

    // Assert
    const expectedDetail = "Receiving objects 42%"
    expect(detail).toBe(expectedDetail)
  })

  it("returns null for a non-progress line", () => {
    // Arrange
    const ordinaryLine = "Cloning into '/tmp/x'..."

    // Act
    const detail = parseGitProgress(ordinaryLine)

    // Assert
    expect(detail).toBeNull()
  })
})
