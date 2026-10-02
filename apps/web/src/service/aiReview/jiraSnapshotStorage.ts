import type { AiReviewTarget } from "@pr-visulizer/shared"
import { aiReviewTargetSchema } from "@pr-visulizer/shared"
import { z } from "zod"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import { serializeStorageMutation } from "./storageMutationQueue"

const SNAPSHOT_IDS_KEY = "ai-review:jira:snapshot-ids"

const jiraCommentSnapshotSchema = z.object({
  author: z.string().min(1),
  createdAt: z.string().min(1),
  body: z.string().min(1),
})

export const jiraIssueSnapshotSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  runId: z.string().min(1),
  target: aiReviewTargetSchema,
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  issue: z.object({
    key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/),
    url: z.string().url(),
    summary: z.string().min(1),
    description: z.string().nullable(),
    acceptanceCriteria: z.array(z.string().min(1)),
    comments: z.array(jiraCommentSnapshotSchema),
  }),
  fetchedAt: z.string().min(1),
  jiraUpdatedAt: z.string().min(1).nullable(),
})
export type JiraIssueSnapshot = z.infer<typeof jiraIssueSnapshotSchema>

export type JiraSnapshotRefreshRunPlan = {
  sourceRunId: string
  nextRunId: string
  snapshotIds: string[]
  issueKeys: string[]
}

function snapshotKey(snapshotId: string): string {
  return `ai-review:jira:snapshot:${encodeURIComponent(snapshotId)}`
}

function deletedRunTombstoneKey(runId: string): string {
  return `ai-review:jira:deleted-run:${encodeURIComponent(runId)}`
}

async function loadValidated<T>(
  store: KeyValueStore,
  key: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const raw = await store.get(key)
  if (raw === null) return null

  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function loadSnapshotIds(store: KeyValueStore): Promise<string[]> {
  return (await loadValidated(store, SNAPSHOT_IDS_KEY, z.array(z.string().min(1)))) ?? []
}

async function deleteSnapshotsForRunWithinMutation(
  store: KeyValueStore,
  runId: string
): Promise<void> {
  const snapshotIds = await loadSnapshotIds(store)
  const snapshots = await Promise.all(
    snapshotIds.map(async (snapshotId) => ({
      snapshotId,
      snapshot: await loadValidated(store, snapshotKey(snapshotId), jiraIssueSnapshotSchema),
    }))
  )
  const deletedSnapshotIds = new Set(
    snapshots
      .filter(({ snapshot }) => snapshot?.runId === runId)
      .map(({ snapshotId }) => snapshotId)
  )

  await Promise.all(
    [...deletedSnapshotIds].map((snapshotId) => store.delete(snapshotKey(snapshotId)))
  )
  if (deletedSnapshotIds.size > 0) {
    await store.set(
      SNAPSHOT_IDS_KEY,
      JSON.stringify(snapshotIds.filter((snapshotId) => !deletedSnapshotIds.has(snapshotId)))
    )
  }
}

// Run deletion and Jira snapshot cleanup share one backing-store mutation boundary so a
// concurrent snapshot save cannot interleave after the snapshot index has been inspected.
export function deleteRunWithAssociatedJiraSnapshots<T>(
  store: KeyValueStore,
  runId: string,
  deleteRunRecords: () => Promise<T>
): Promise<T> {
  return serializeStorageMutation(store, async () => {
    // The tombstone makes deletion final for this immutable run ID before a queued snapshot
    // save can execute on the same backing-store mutation boundary.
    await store.set(deletedRunTombstoneKey(runId), "true")
    await deleteSnapshotsForRunWithinMutation(store, runId)
    return deleteRunRecords()
  })
}

function sameTarget(left: AiReviewTarget, right: AiReviewTarget): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.number === right.number
}

// Refreshing always plans a different immutable review run. It neither fetches Jira nor modifies
// a prior snapshot; S23 will use this plan only after a separate explicit read approval.
export function createJiraSnapshotRefreshRunPlan(
  snapshots: readonly JiraIssueSnapshot[],
  nextRunId: string
): JiraSnapshotRefreshRunPlan {
  const parsedSnapshots = snapshots.map((snapshot) => jiraIssueSnapshotSchema.parse(snapshot))
  if (parsedSnapshots.length === 0) throw new Error("Refreshing Jira context requires a snapshot")

  const sourceRunId = parsedSnapshots[0]!.runId
  if (nextRunId.trim().length === 0 || nextRunId === sourceRunId) {
    throw new Error("Refreshing Jira context requires a different new review run ID")
  }
  if (parsedSnapshots.some((snapshot) => snapshot.runId !== sourceRunId)) {
    throw new Error("Refreshing Jira context requires snapshots from one prior review run")
  }

  return {
    sourceRunId,
    nextRunId,
    snapshotIds: parsedSnapshots.map((snapshot) => snapshot.id),
    issueKeys: parsedSnapshots.map((snapshot) => snapshot.issue.key),
  }
}

export function createJiraSnapshotStorage(store: KeyValueStore) {
  const mutate = <T>(mutation: () => Promise<T>): Promise<T> =>
    serializeStorageMutation(store, mutation)
  const loadSnapshot = (snapshotId: string): Promise<JiraIssueSnapshot | null> =>
    loadValidated(store, snapshotKey(snapshotId), jiraIssueSnapshotSchema)

  const listSnapshots = async (target?: AiReviewTarget): Promise<JiraIssueSnapshot[]> => {
    const snapshotIds = await loadSnapshotIds(store)
    const snapshots = await Promise.all(snapshotIds.map(loadSnapshot))
    return snapshots
      .filter((snapshot): snapshot is JiraIssueSnapshot => snapshot !== null)
      .filter((snapshot) => !target || sameTarget(snapshot.target, target))
      .sort(
        (left, right) =>
          left.fetchedAt.localeCompare(right.fetchedAt) || left.id.localeCompare(right.id)
      )
  }

  return {
    loadSnapshot,
    listSnapshots,

    deleteSnapshotsForRun(runId: string): Promise<void> {
      return mutate(() => deleteSnapshotsForRunWithinMutation(store, runId))
    },

    saveSnapshot(snapshot: JiraIssueSnapshot): Promise<JiraIssueSnapshot> {
      return mutate(async () => {
        const parsedSnapshot = jiraIssueSnapshotSchema.parse(snapshot)
        if (await store.get(deletedRunTombstoneKey(parsedSnapshot.runId))) {
          throw new Error(`AI review run ${parsedSnapshot.runId} has been deleted`)
        }
        if (await store.get(snapshotKey(parsedSnapshot.id))) {
          throw new Error(`Jira snapshot ${parsedSnapshot.id} is immutable`)
        }

        const existing = await listSnapshots(parsedSnapshot.target)
        if (
          existing.some(
            (stored) =>
              stored.runId === parsedSnapshot.runId &&
              stored.issue.key === parsedSnapshot.issue.key &&
              stored.version === parsedSnapshot.version
          )
        ) {
          throw new Error(
            `Jira snapshot ${parsedSnapshot.issue.key} version ${parsedSnapshot.version} already exists for this run`
          )
        }

        await store.set(snapshotKey(parsedSnapshot.id), JSON.stringify(parsedSnapshot))
        const snapshotIds = await loadSnapshotIds(store)
        if (!snapshotIds.includes(parsedSnapshot.id)) {
          await store.set(SNAPSHOT_IDS_KEY, JSON.stringify([...snapshotIds, parsedSnapshot.id]))
        }

        return parsedSnapshot
      })
    },
  }
}

export type JiraSnapshotStorage = ReturnType<typeof createJiraSnapshotStorage>
