import type { ChangedFile, RankedFile, ReviewCoverage } from "@pr-visulizer/shared"

export type ReviewChunkPolicy = {
  maxFilesPerChunk: number
  maxChurnPerChunk: number
}

export const DEFAULT_REVIEW_CHUNK_POLICY: ReviewChunkPolicy = {
  maxFilesPerChunk: 25,
  maxChurnPerChunk: 1_000,
}

export type ReviewChunk = {
  id: string
  paths: string[]
  churn: number
  exceedsChurnLimit: boolean
}

export type ReviewChunkPlan = {
  policy: ReviewChunkPolicy
  chunks: ReviewChunk[]
  synthesis: { required: boolean; id: string | null }
  expectedCoverage: {
    plannedPaths: string[]
    skipped: Array<{ path: string; reason: string }>
    partial: boolean
  }
}

export type ChunkExecutionStatus = "completed" | "failed"

export type ChunkExecution = {
  chunkId: string
  status: ChunkExecutionStatus
}

export type ChunkSynthesisStatus = "completed" | "failed" | "not-run"

function assertPositiveInteger(value: number, setting: keyof ReviewChunkPolicy): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${setting} must be a positive integer`)
  }
}

// Presets can be added when review profiles need distinct chunk budgets. Until then, callers may
// override the two demonstrated context limits without coupling the plan to a provider.
export function resolveReviewChunkPolicy(
  overrides: Partial<ReviewChunkPolicy> = {}
): ReviewChunkPolicy {
  const policy = { ...DEFAULT_REVIEW_CHUNK_POLICY, ...overrides }
  assertPositiveInteger(policy.maxFilesPerChunk, "maxFilesPerChunk")
  assertPositiveInteger(policy.maxChurnPerChunk, "maxChurnPerChunk")

  return policy
}

function filesByPath(files: ChangedFile[]): Map<string, ChangedFile> {
  const byPath = new Map<string, ChangedFile>()
  for (const file of files) {
    if (byPath.has(file.path)) throw new Error(`Changed files contain duplicate path: ${file.path}`)
    byPath.set(file.path, file)
  }

  return byPath
}

function rankedFilesInDependencyOrder(
  files: Map<string, ChangedFile>,
  ranking: RankedFile[]
): ChangedFile[] {
  const rankedPaths = new Set<string>()
  const ordered = [...ranking].sort(
    (left, right) => left.order - right.order || left.path.localeCompare(right.path)
  )

  return ordered.map((rankedFile) => {
    if (!files.has(rankedFile.path)) {
      throw new Error(`Ranking contains a path that is not a changed file: ${rankedFile.path}`)
    }
    if (rankedPaths.has(rankedFile.path)) {
      throw new Error(`Ranking contains duplicate path: ${rankedFile.path}`)
    }

    rankedPaths.add(rankedFile.path)
    return files.get(rankedFile.path)!
  })
}

function missingRankings(files: Map<string, ChangedFile>, rankedFiles: ChangedFile[]) {
  const rankedPaths = new Set(rankedFiles.map((file) => file.path))

  return [...files.values()]
    .filter((file) => !rankedPaths.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ path: file.path, reason: "missing dependency ranking" }))
}

function toChunk(id: number, files: ChangedFile[], policy: ReviewChunkPolicy): ReviewChunk {
  const churn = files.reduce((total, file) => total + file.additions + file.deletions, 0)

  return {
    id: `review-${id}`,
    paths: files.map((file) => file.path),
    churn,
    exceedsChurnLimit: churn > policy.maxChurnPerChunk,
  }
}

// Keep the existing ranking's dependency-first order intact while fitting bounded groups. A file
// larger than the churn limit is still reviewed alone: silently omitting changed behavior would
// falsely improve coverage, so its limit exception remains visible on the chunk instead.
function chunkRankedFiles(files: ChangedFile[], policy: ReviewChunkPolicy): ReviewChunk[] {
  const chunks: ReviewChunk[] = []
  let pending: ChangedFile[] = []
  let pendingChurn = 0

  function flush(): void {
    if (pending.length === 0) return

    chunks.push(toChunk(chunks.length + 1, pending, policy))
    pending = []
    pendingChurn = 0
  }

  for (const file of files) {
    const churn = file.additions + file.deletions
    const wouldExceedFileLimit = pending.length >= policy.maxFilesPerChunk
    const wouldExceedChurnLimit =
      pending.length > 0 && pendingChurn + churn > policy.maxChurnPerChunk
    if (wouldExceedFileLimit || wouldExceedChurnLimit) flush()

    pending.push(file)
    pendingChurn += churn
  }
  flush()

  return chunks
}

export function createReviewChunkPlan(
  files: ChangedFile[],
  ranking: RankedFile[],
  overrides: Partial<ReviewChunkPolicy> = {}
): ReviewChunkPlan {
  const policy = resolveReviewChunkPolicy(overrides)
  const changedFiles = filesByPath(files)
  const rankedFiles = rankedFilesInDependencyOrder(changedFiles, ranking)
  const skipped = missingRankings(changedFiles, rankedFiles)
  const chunks = chunkRankedFiles(rankedFiles, policy)

  return {
    policy,
    chunks,
    synthesis:
      chunks.length > 1 ? { required: true, id: "synthesis" } : { required: false, id: null },
    expectedCoverage: {
      plannedPaths: rankedFiles.map((file) => file.path),
      skipped,
      partial: skipped.length > 0,
    },
  }
}

function executionStatusByChunk(execution: ChunkExecution[]): Map<string, ChunkExecutionStatus> {
  const statuses = new Map<string, ChunkExecutionStatus>()
  for (const result of execution) {
    if (statuses.has(result.chunkId))
      throw new Error(`Chunk execution was reported twice: ${result.chunkId}`)
    statuses.set(result.chunkId, result.status)
  }

  return statuses
}

// Derive persisted ReviewCoverage only from explicit execution results. In particular, an
// unsynthesized multi-chunk review remains partial even if every individual chunk completed.
export function createChunkExecutionCoverage(
  plan: ReviewChunkPlan,
  execution: ChunkExecution[],
  synthesisStatus: ChunkSynthesisStatus = "not-run"
): ReviewCoverage {
  const knownChunkIds = new Set(plan.chunks.map((chunk) => chunk.id))
  const statuses = executionStatusByChunk(execution)
  for (const chunkId of statuses.keys()) {
    if (!knownChunkIds.has(chunkId)) throw new Error(`Execution reported unknown chunk: ${chunkId}`)
  }

  const skipped = [...plan.expectedCoverage.skipped]
  const failedChunks: string[] = []
  const reviewedPaths: string[] = []

  for (const chunk of plan.chunks) {
    const status = statuses.get(chunk.id)
    if (status === "completed") {
      reviewedPaths.push(...chunk.paths)
      continue
    }

    if (status === "failed") failedChunks.push(chunk.id)
    const reason = status === "failed" ? "review chunk failed" : "review chunk did not complete"
    skipped.push(...chunk.paths.map((path) => ({ path, reason })))
  }

  const synthesisCompleted = !plan.synthesis.required || synthesisStatus === "completed"

  return {
    reviewedPaths,
    skipped,
    failedChunks,
    missingContent: [],
    excludedSensitivePaths: [],
    synthesisCompleted,
  }
}
