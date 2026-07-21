import { describe, expect, it, vi } from "vitest"

import { createFakeGithubGateway } from "../src/services/githubGateway/fakeGateway.js"
import type { GithubGateway, PrTarget } from "../src/services/githubGateway/gateway.js"
import { createViewedSyncService } from "../src/services/viewedSync/viewedSync.js"

// The two-way "Viewed" sync end-to-end through the gateway seam (docs/architecture.md §11).
// PR #42's real fixture paths, so the fake gateway serves a genuine changed-file list.

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

const LIMITS = "src/config/limits.ts"
const HTTP = "src/types/http.ts"

describe("fake gateway viewed state", () => {
  it("round-trips a mark and an unmark through listViewedFiles", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const path = LIMITS

    // Act
    await gateway.setFileViewed(target, path, true)
    const afterMark = await gateway.listViewedFiles(target)
    await gateway.setFileViewed(target, path, false)
    const afterUnmark = await gateway.listViewedFiles(target)

    // Assert
    const expected = { afterMark: "VIEWED", afterUnmark: "UNVIEWED" }
    expect({ afterMark: afterMark[path], afterUnmark: afterUnmark[path] }).toEqual(expected)
  })
})

describe("viewed sync reconcile", () => {
  it("pushes a local checkmark GitHub has not seen, and records the new ancestor", async () => {
    // Arrange
    const gateway = createFakeGithubGateway()
    const sync = createViewedSyncService(gateway)
    const local = [LIMITS]
    const base = null

    // Act
    const result = await sync.reconcile({ target, local, base })

    // Assert — GitHub was told exactly once, in the mark direction.
    const expected = {
      reviewedFiles: [LIMITS],
      syncedViewedFiles: [LIMITS],
      sync: { status: "synced" },
      writes: [{ target, path: LIMITS, viewed: true }],
    }
    expect({
      reviewedFiles: result.reviewedFiles,
      syncedViewedFiles: result.syncedViewedFiles,
      sync: result.sync,
      writes: gateway.viewedWrites,
    }).toEqual(expected)
  })

  it("pulls in a file the reviewer ticked on github.com", async () => {
    // Arrange — the reviewer ticked "Viewed" on the GitHub web UI; the app knows nothing.
    const gateway = createFakeGithubGateway()
    const sync = createViewedSyncService(gateway)
    gateway.setRemoteViewed(target, HTTP, true)
    const local: string[] = []
    const base = null

    // Act
    const result = await sync.reconcile({ target, local, base })

    // Assert — no write was needed; GitHub's state simply became ours.
    const expected = { reviewedFiles: [HTTP], writes: [] }
    expect({ reviewedFiles: result.reviewedFiles, writes: gateway.viewedWrites }).toEqual(expected)
  })

  it("propagates an un-view done on github.com once an ancestor exists", async () => {
    // Arrange — a first sync establishes the ancestor, then the reviewer unticks on GitHub.
    const gateway = createFakeGithubGateway()
    const sync = createViewedSyncService(gateway)
    const first = await sync.reconcile({ target, local: [LIMITS, HTTP], base: null })
    gateway.setRemoteViewed(target, HTTP, false)

    // Act
    const second = await sync.reconcile({
      target,
      local: first.reviewedFiles,
      base: first.syncedViewedFiles,
    })

    // Assert — the un-view wins over the stale local checkmark instead of being re-added.
    const expected = { reviewedFiles: [LIMITS], sync: { status: "synced" } }
    expect({ reviewedFiles: second.reviewedFiles, sync: second.sync }).toEqual(expected)
  })

  it("keeps the local checkmark and flags degraded when the GitHub write fails", async () => {
    // Arrange — reads work, writes are rejected (a revoked scope / a rate limit).
    const failure = new Error("GraphQL: Resource not accessible by integration")
    const gateway = createFakeGithubGateway()
    const failingGateway: GithubGateway = {
      ...gateway,
      setFileViewed: vi.fn(async () => {
        throw failure
      }),
    }
    const sync = createViewedSyncService(failingGateway)
    const local = [LIMITS]
    const base = null

    // Act
    const result = await sync.reconcile({ target, local, base })

    // Assert — the checkmark survives, the ancestor is NOT advanced, and the UI can say so.
    const expected = {
      reviewedFiles: [LIMITS],
      syncedViewedFiles: null,
      sync: { status: "degraded", reason: failure.message },
    }
    expect(result).toEqual(expected)
  })

  it("keeps the local checkmarks when GitHub cannot even be read", async () => {
    // Arrange
    const failure = new Error("offline")
    const gateway = createFakeGithubGateway()
    const failingGateway: GithubGateway = {
      ...gateway,
      listViewedFiles: vi.fn(async () => {
        throw failure
      }),
    }
    const sync = createViewedSyncService(failingGateway)
    const local = [LIMITS, HTTP]
    const base = null

    // Act
    const result = await sync.reconcile({ target, local, base })

    // Assert
    const expected = {
      reviewedFiles: [LIMITS, HTTP],
      syncedViewedFiles: null,
      sync: { status: "degraded", reason: failure.message },
    }
    expect(result).toEqual(expected)
  })
})
