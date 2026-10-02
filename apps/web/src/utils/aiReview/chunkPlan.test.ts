import type { ChangedFile, RankedFile } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import {
  createChunkExecutionCoverage,
  createReviewChunkPlan,
  resolveReviewChunkPolicy,
} from "./chunkPlan"

const changedFiles: ChangedFile[] = [
  { path: "src/config.ts", status: "added", additions: 2, deletions: 0, language: "TypeScript" },
  {
    path: "src/limiter.ts",
    status: "modified",
    additions: 6,
    deletions: 2,
    language: "TypeScript",
  },
  { path: "src/route.ts", status: "modified", additions: 4, deletions: 1, language: "TypeScript" },
]

const dependencyRanking: RankedFile[] = [
  { path: "src/config.ts", topoLevel: 0, fanIn: 1, churn: 2, order: 1 },
  { path: "src/limiter.ts", topoLevel: 1, fanIn: 1, churn: 8, order: 2 },
  { path: "src/route.ts", topoLevel: 2, fanIn: 0, churn: 5, order: 3 },
]

describe("review chunk planning", () => {
  it("keeps dependency-ranked files in bounded chunks and requires synthesis for a split review", () => {
    // Arrange
    const namedChangedFiles = changedFiles
    const namedDependencyRanking = dependencyRanking
    const namedChunkLimits = { maxFilesPerChunk: 2, maxChurnPerChunk: 10 }

    // Act
    const plan = createReviewChunkPlan(namedChangedFiles, namedDependencyRanking, namedChunkLimits)

    // Assert
    expect(plan).toEqual({
      policy: namedChunkLimits,
      chunks: [
        {
          id: "review-1",
          paths: ["src/config.ts", "src/limiter.ts"],
          churn: 10,
          exceedsChurnLimit: false,
        },
        {
          id: "review-2",
          paths: ["src/route.ts"],
          churn: 5,
          exceedsChurnLimit: false,
        },
      ],
      synthesis: { required: true, id: "synthesis" },
      expectedCoverage: {
        plannedPaths: ["src/config.ts", "src/limiter.ts", "src/route.ts"],
        skipped: [],
        partial: false,
      },
    })
  })

  it("discloses a missing ranking as partial coverage and keeps an oversized file visible", () => {
    // Arrange
    const namedChangedFiles = [
      ...changedFiles,
      {
        path: "src/unranked.ts",
        status: "added" as const,
        additions: 1,
        deletions: 0,
        language: "TypeScript",
      },
    ]
    const namedPartialRanking = dependencyRanking
    const namedSmallChurnLimit = { maxFilesPerChunk: 5, maxChurnPerChunk: 4 }

    // Act
    const plan = createReviewChunkPlan(namedChangedFiles, namedPartialRanking, namedSmallChurnLimit)

    // Assert
    expect(plan.chunks).toEqual([
      {
        id: "review-1",
        paths: ["src/config.ts"],
        churn: 2,
        exceedsChurnLimit: false,
      },
      {
        id: "review-2",
        paths: ["src/limiter.ts"],
        churn: 8,
        exceedsChurnLimit: true,
      },
      {
        id: "review-3",
        paths: ["src/route.ts"],
        churn: 5,
        exceedsChurnLimit: true,
      },
    ])
    expect(plan.expectedCoverage).toEqual({
      plannedPaths: ["src/config.ts", "src/limiter.ts", "src/route.ts"],
      skipped: [{ path: "src/unranked.ts", reason: "missing dependency ranking" }],
      partial: true,
    })
  })

  it("marks a fully chunk-reviewed run partial until its required synthesis completes", () => {
    // Arrange
    const namedSplitPlan = createReviewChunkPlan(changedFiles, dependencyRanking, {
      maxFilesPerChunk: 2,
      maxChurnPerChunk: 10,
    })
    const namedCompletedChunks = [
      { chunkId: "review-1", status: "completed" as const },
      { chunkId: "review-2", status: "completed" as const },
    ]

    // Act
    const coverageWithoutSynthesis = createChunkExecutionCoverage(
      namedSplitPlan,
      namedCompletedChunks,
      "not-run"
    )

    // Assert
    expect(coverageWithoutSynthesis).toEqual({
      reviewedPaths: ["src/config.ts", "src/limiter.ts", "src/route.ts"],
      skipped: [],
      failedChunks: [],
      missingContent: [],
      excludedSensitivePaths: [],
      synthesisCompleted: false,
    })
  })

  it("discloses failed review chunks instead of treating their paths as reviewed", () => {
    // Arrange
    const namedSplitPlan = createReviewChunkPlan(changedFiles, dependencyRanking, {
      maxFilesPerChunk: 2,
      maxChurnPerChunk: 10,
    })
    const namedFailedExecution = [
      { chunkId: "review-1", status: "completed" as const },
      { chunkId: "review-2", status: "failed" as const },
    ]

    // Act
    const coverageWithFailedChunk = createChunkExecutionCoverage(
      namedSplitPlan,
      namedFailedExecution,
      "not-run"
    )

    // Assert
    expect(coverageWithFailedChunk).toEqual({
      reviewedPaths: ["src/config.ts", "src/limiter.ts"],
      skipped: [{ path: "src/route.ts", reason: "review chunk failed" }],
      failedChunks: ["review-2"],
      missingContent: [],
      excludedSensitivePaths: [],
      synthesisCompleted: false,
    })
  })

  it("rejects invalid chunk limits before it plans context", () => {
    // Arrange
    const namedInvalidLimit = { maxFilesPerChunk: 0 }

    // Act
    const resolveInvalidLimit = () => resolveReviewChunkPolicy(namedInvalidLimit)

    // Assert
    expect(resolveInvalidLimit).toThrow("maxFilesPerChunk must be a positive integer")
  })
})
