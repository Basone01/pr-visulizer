import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import type { JiraIssueSnapshot } from "./jiraSnapshotStorage"
import { createJiraSnapshotRefreshRunPlan, createJiraSnapshotStorage } from "./jiraSnapshotStorage"

const TARGET = { owner: "acme", repo: "webapp", number: 42 }

function snapshot(overrides: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot {
  return {
    id: "jira-snapshot-1",
    version: 1,
    runId: "run-1",
    target: TARGET,
    baseSha: "base-sha",
    headSha: "head-sha",
    issue: {
      key: "WEB-42",
      url: "https://jira.example.com/browse/WEB-42",
      summary: "Protect the authorization route",
      description: "The route must reject unauthorized access.",
      acceptanceCriteria: ["Unauthorized access returns 403."],
      comments: [
        {
          author: "product-owner",
          createdAt: "2026-09-14T12:00:00.000Z",
          body: "403 is required for unauthenticated requests.",
        },
      ],
    },
    fetchedAt: "2026-09-14T12:01:00.000Z",
    jiraUpdatedAt: "2026-09-14T11:59:00.000Z",
    ...overrides,
  }
}

describe("Jira snapshot storage", () => {
  it("persists immutable versioned selected Jira context locally", async () => {
    // Arrange
    const storage = createJiraSnapshotStorage(createMemoryKeyValueStore())
    const firstVersion = snapshot()
    const secondVersion = snapshot({
      id: "jira-snapshot-2",
      version: 2,
      fetchedAt: "2026-09-14T12:02:00.000Z",
      jiraUpdatedAt: "2026-09-14T12:00:30.000Z",
    })

    // Act
    await storage.saveSnapshot(firstVersion)
    await storage.saveSnapshot(secondVersion)
    const rewrite = storage.saveSnapshot({
      ...firstVersion,
      issue: { ...firstVersion.issue, summary: "Changed" },
    })

    // Assert
    expect(await storage.listSnapshots(TARGET)).toEqual([firstVersion, secondVersion])
    await expect(rewrite).rejects.toThrow("immutable")
  })

  it("concurrent_factories_preserve_same_and_different_record_indexes", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const firstFactory = createJiraSnapshotStorage(store)
    const secondFactory = createJiraSnapshotStorage(store)
    const firstSnapshot = snapshot()
    const secondSnapshot = snapshot({
      id: "jira-snapshot-2",
      version: 2,
      fetchedAt: "2026-09-14T12:02:00.000Z",
    })
    const thirdSnapshot = snapshot({
      id: "jira-snapshot-3",
      version: 3,
      fetchedAt: "2026-09-14T12:03:00.000Z",
    })

    // Act
    const sameIdResults = await Promise.allSettled([
      firstFactory.saveSnapshot(firstSnapshot),
      secondFactory.saveSnapshot(firstSnapshot),
    ])
    await Promise.all([
      firstFactory.saveSnapshot(secondSnapshot),
      secondFactory.saveSnapshot(thirdSnapshot),
    ])

    // Assert
    expect(sameIdResults.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(sameIdResults.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await createJiraSnapshotStorage(store).listSnapshots(TARGET)).toEqual([
      firstSnapshot,
      secondSnapshot,
      thirdSnapshot,
    ])
  })

  it("deletes snapshots for one run without retaining their index entries", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createJiraSnapshotStorage(store)
    const deletedRunSnapshot = snapshot()
    const retainedRunSnapshot = snapshot({
      id: "jira-snapshot-2",
      runId: "run-2",
      version: 2,
      fetchedAt: "2026-09-14T12:02:00.000Z",
    })
    await storage.saveSnapshot(deletedRunSnapshot)
    await storage.saveSnapshot(retainedRunSnapshot)

    // Act
    await storage.deleteSnapshotsForRun(deletedRunSnapshot.runId)

    // Assert
    expect(await storage.loadSnapshot(deletedRunSnapshot.id)).toBeNull()
    expect(await storage.listSnapshots()).toEqual([retainedRunSnapshot])
    expect(await store.get("ai-review:jira:snapshot-ids")).toBe(
      JSON.stringify([retainedRunSnapshot.id])
    )
    expect(await store.get("ai-review:jira:snapshot:jira-snapshot-1")).toBeNull()
  })

  it("plans refresh against a new run without mutating the old Jira snapshot", async () => {
    // Arrange
    const storage = createJiraSnapshotStorage(createMemoryKeyValueStore())
    const previousSnapshot = snapshot()
    await storage.saveSnapshot(previousSnapshot)

    // Act
    const refresh = createJiraSnapshotRefreshRunPlan([previousSnapshot], "run-2")

    // Assert
    expect(refresh).toEqual({
      sourceRunId: "run-1",
      nextRunId: "run-2",
      snapshotIds: [previousSnapshot.id],
      issueKeys: ["WEB-42"],
    })
    expect(await storage.loadSnapshot(previousSnapshot.id)).toEqual(previousSnapshot)
    expect(() => createJiraSnapshotRefreshRunPlan([previousSnapshot], "run-1")).toThrow(
      "different new review run ID"
    )
  })
})
