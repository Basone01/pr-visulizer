import type { AiReviewRun, FindingDisposition, ReviewRunOutput } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { type JiraIssueSnapshot, createJiraSnapshotStorage } from "./jiraSnapshotStorage"
import { type PersistedAiReviewDiagnostics, createAiReviewRunStorage } from "./runStorage"

function createCompletedRun(overrides: Partial<AiReviewRun> = {}): AiReviewRun {
  return {
    id: "run-1",
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    inputFingerprint: "input-fingerprint",
    contextSecurityFingerprint: "context-security-fingerprint",
    provider: "fake",
    selectedModel: null,
    reportedModel: "fake-model",
    cliVersion: "1.0.0",
    promptVersion: "ai-review-v1",
    profile: "balanced",
    status: "completed",
    summary: "The implementation has one finding.",
    findings: [
      {
        id: "finding-1",
        title: "Missing authorization check",
        severity: "high",
        confidence: "high",
        category: "security",
        path: "src/route.ts",
        side: "RIGHT",
        startLine: 8,
        endLine: 8,
        evidence: "The route accepts the request without checking its owner.",
        impact: "A user could read another user's data.",
        suggestedFix: "Check ownership before loading the record.",
        source: "code-review",
      },
    ],
    requirementCoverage: null,
    coverage: {
      reviewedPaths: ["src/route.ts"],
      skipped: [],
      failedChunks: [],
      missingContent: [],
      excludedSensitivePaths: [],
      synthesisCompleted: true,
    },
    usage: {
      elapsedMs: 250,
      parentAgentCount: 1,
      nestedAgentCount: 0,
      toolEventCount: 1,
      approvedCommandCount: 0,
      inputTokens: null,
      outputTokens: null,
      providerCost: null,
    },
    createdAt: "2026-09-13T12:00:00.000Z",
    completedAt: "2026-09-13T12:00:01.000Z",
    ...overrides,
  }
}

function createRunningRun(overrides: Partial<AiReviewRun> = {}): AiReviewRun {
  return createCompletedRun({
    status: "running",
    summary: null,
    findings: [],
    reportedModel: null,
    completedAt: null,
    ...overrides,
  })
}

function outputFromRun(run: AiReviewRun): ReviewRunOutput {
  return {
    summary: run.summary ?? "Fixture summary",
    findings: run.findings,
    requirementCoverage: run.requirementCoverage,
    coverage: run.coverage,
    usage: run.usage,
    reportedModel: run.reportedModel,
  }
}

function recordedPatches(run: AiReviewRun) {
  return {
    baseSha: run.baseSha,
    headSha: run.headSha,
    patches: {
      "src/route.ts": "@@ -8,1 +8,1 @@\n-old handler\n+new handler\n",
    },
  }
}

const SELECTED_JIRA_CRITERIA = [
  { issueKey: "WEB-42", criterion: "Unauthorized access returns 403." },
]

function createDuplicateRequirementOutput(
  firstReviewerQuestion: string | null,
  secondReviewerQuestion: string | null
): ReviewRunOutput {
  const requirementMismatch = {
    ...createCompletedRun().findings[0]!,
    id: "requirement-mismatch-duplicate",
    source: "requirement-mismatch" as const,
    requirementCriterion: SELECTED_JIRA_CRITERIA[0],
  }
  const createCoverageItem = (reviewerQuestion: string | null) => ({
    issueKey: "WEB-42",
    criterion: "Unauthorized access returns 403.",
    state: "contradicted" as const,
    evidence: [
      {
        source: "jira" as const,
        reference: "WEB-42 acceptance criterion 1",
        detail: "The criterion requires a 403 response.",
      },
      {
        source: "code" as const,
        reference: "src/route.ts:8",
        detail: "The route returns a successful response instead.",
      },
    ],
    reviewerQuestion,
  })

  return {
    ...outputFromRun(createCompletedRun()),
    findings: [requirementMismatch],
    requirementCoverage: {
      status: "available",
      unavailableIssueKeys: [],
      items: [
        createCoverageItem(firstReviewerQuestion),
        createCoverageItem(secondReviewerQuestion),
      ],
    },
  }
}

function createOpenDisposition(): FindingDisposition {
  return {
    runId: "run-1",
    findingId: "finding-1",
    state: "open",
    updatedAt: "2026-09-13T12:00:02.000Z",
  }
}

function createJiraSnapshot(): JiraIssueSnapshot {
  return {
    id: "jira-snapshot-1",
    version: 1,
    runId: "run-1",
    target: { owner: "acme", repo: "web", number: 42 },
    baseSha: "base-sha",
    headSha: "head-sha",
    issue: {
      key: "WEB-42",
      url: "https://jira.example.com/browse/WEB-42",
      summary: "Protect the authorization route",
      description: "The route must reject unauthorized access.",
      acceptanceCriteria: ["Unauthorized access returns 403."],
      comments: [],
    },
    fetchedAt: "2026-09-13T12:00:00.000Z",
    jiraUpdatedAt: "2026-09-13T11:59:00.000Z",
  }
}

describe("AI review run storage", () => {
  it("persists only schema-valid AI run, disposition, and permitted diagnostic records", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const completedRun = createCompletedRun()
    const openDisposition = createOpenDisposition()
    const permittedDiagnostics: PersistedAiReviewDiagnostics = {
      runId: completedRun.id,
      sanitizedEvents: [{ type: "diagnostic", runId: completedRun.id, message: "Chunk complete" }],
      rawModelOutputPermitted: true,
      rawModelOutput: '{"summary":"validated"}',
    }
    const disallowedRawOutput = {
      ...permittedDiagnostics,
      rawModelOutputPermitted: false,
    }

    // Act
    const runningRun = createRunningRun()
    await storage.createRun(runningRun)
    await storage.finalizeRun(
      runningRun.id,
      outputFromRun(completedRun),
      recordedPatches(runningRun),
      completedRun.completedAt ?? "2026-09-13T12:00:01.000Z"
    )
    await storage.saveDisposition(openDisposition)
    await storage.saveDiagnostics(permittedDiagnostics)
    const invalidDiagnosticSave = storage.saveDiagnostics(disallowedRawOutput)
    const rawCompletedInsert = storage.createRun(completedRun)
    await store.set("ai-review:run:malformed", "not JSON")
    const malformedRun = await storage.loadRun("malformed")

    // Assert
    await expect(invalidDiagnosticSave).rejects.toThrow(
      "Raw model output may only be stored when explicitly permitted"
    )
    await expect(rawCompletedInsert).rejects.toThrow(
      "AI review runs must begin in the running state"
    )
    expect(await storage.loadRun(completedRun.id)).toEqual(completedRun)
    expect(await storage.loadDispositions(completedRun.id)).toEqual([openDisposition])
    expect(await storage.loadDiagnostics(completedRun.id)).toEqual(permittedDiagnostics)
    expect(malformedRun).toBeNull()
  })

  it("keeps completed model output immutable while allowing separate dispositions", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const runningRun = createRunningRun()
    const completedRun = createCompletedRun()
    const savedAsDraftDisposition: FindingDisposition = {
      ...createOpenDisposition(),
      state: "saved-as-draft",
      updatedAt: "2026-09-13T12:00:03.000Z",
    }
    await storage.createRun(runningRun)
    await storage.finalizeRun(
      runningRun.id,
      outputFromRun(completedRun),
      recordedPatches(runningRun),
      completedRun.completedAt ?? "2026-09-13T12:00:01.000Z"
    )

    // Act
    await storage.saveDisposition(createOpenDisposition())
    await storage.saveDisposition(savedAsDraftDisposition)
    const overwriteCompletedRun = storage.finalizeRun(
      completedRun.id,
      outputFromRun({ ...completedRun, summary: "Rewritten model output must not be accepted." }),
      recordedPatches(completedRun),
      "2026-09-13T12:00:04.000Z"
    )

    // Assert
    await expect(overwriteCompletedRun).rejects.toThrow("already terminal")
    expect(await storage.loadRun(completedRun.id)).toEqual(completedRun)
    expect(await storage.loadDispositions(completedRun.id)).toEqual([savedAsDraftDisposition])
  })

  it("stores malformed output as invalid and disclosed partial output as completed", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const invalidRunningRun = createRunningRun({ id: "invalid-run" })
    const partialRunningRun = createRunningRun({ id: "partial-run" })
    const partialOutput = {
      summary: "Only the safe source files were reviewed.",
      findings: [],
      requirementCoverage: null,
      coverage: {
        reviewedPaths: ["src/route.ts"],
        skipped: [{ path: "src/secret.ts", reason: "sensitive file excluded" }],
        failedChunks: [],
        missingContent: [],
        excludedSensitivePaths: ["src/secret.ts"],
        synthesisCompleted: true,
      },
      usage: partialRunningRun.usage,
      reportedModel: "fake-model",
    }
    await storage.createRun(invalidRunningRun)
    await storage.createRun(partialRunningRun)

    // Act
    const invalidTerminal = await storage.finalizeRun(
      invalidRunningRun.id,
      { findings: [] },
      recordedPatches(invalidRunningRun),
      "2026-09-13T12:00:01.000Z"
    )
    const partialTerminal = await storage.finalizeRun(
      partialRunningRun.id,
      partialOutput,
      recordedPatches(partialRunningRun),
      "2026-09-13T12:00:01.000Z"
    )

    // Assert
    expect(invalidTerminal.validation.status).toBe("invalid")
    expect(invalidTerminal.run).toMatchObject({
      status: "invalid",
      summary: null,
      findings: [],
      completedAt: "2026-09-13T12:00:01.000Z",
    })
    expect(partialTerminal.validation).toMatchObject({ status: "completed", partial: true })
    expect(partialTerminal.run).toMatchObject({
      status: "completed",
      summary: "Only the safe source files were reviewed.",
      coverage: partialOutput.coverage,
    })
  })

  it("finalizeRun validates requirement mismatch linkage against selected criteria", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const selectedCriteria = [{ issueKey: "WEB-42", criterion: "Unauthorized access returns 403." }]
    const validRunningRun = createRunningRun({ id: "valid-mismatch-run" })
    const invalidRunningRun = createRunningRun({ id: "invalid-mismatch-run" })
    const coverageItem = {
      issueKey: "WEB-42",
      criterion: "Unauthorized access returns 403.",
      state: "contradicted" as const,
      evidence: [
        {
          source: "jira" as const,
          reference: "WEB-42 acceptance criterion 1",
          detail: "The criterion requires a 403 response.",
        },
        {
          source: "code" as const,
          reference: "src/route.ts:8",
          detail: "The route returns a successful response instead.",
        },
      ],
      reviewerQuestion: null,
    }
    const requirementMismatch = {
      ...createCompletedRun().findings[0]!,
      id: "requirement-mismatch-1",
      source: "requirement-mismatch" as const,
      requirementCriterion: selectedCriteria[0],
    }
    const validOutput: ReviewRunOutput = {
      ...outputFromRun(createCompletedRun()),
      findings: [requirementMismatch],
      requirementCoverage: {
        status: "available",
        unavailableIssueKeys: [],
        items: [coverageItem],
      },
    }
    const invalidOutput: ReviewRunOutput = {
      ...validOutput,
      findings: [
        {
          ...requirementMismatch,
          requirementCriterion: { issueKey: "OPS-9", criterion: "Log every access." },
        },
      ],
    }
    await storage.createRun(validRunningRun)
    await storage.createRun(invalidRunningRun)

    // Act
    const validTerminal = await storage.finalizeRun(
      validRunningRun.id,
      validOutput,
      recordedPatches(validRunningRun),
      "2026-09-13T12:00:01.000Z",
      selectedCriteria
    )
    const invalidTerminal = await storage.finalizeRun(
      invalidRunningRun.id,
      invalidOutput,
      recordedPatches(invalidRunningRun),
      "2026-09-13T12:00:01.000Z",
      selectedCriteria
    )

    // Assert
    expect(validTerminal.run.status).toBe("completed")
    expect(invalidTerminal).toMatchObject({
      run: { status: "invalid", findings: [], requirementCoverage: null },
      validation: {
        status: "invalid",
        errors: [
          "requirement-mismatch-1: requirement mismatch does not reference a selected Jira criterion",
        ],
      },
    })
  })

  it("conflicting_then_authoritative_duplicate_requirement_conclusions_are_invalid", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const runningRun = createRunningRun({ id: "conflicting-first-duplicate-run" })
    const duplicateOutput = createDuplicateRequirementOutput(
      "Jira comments disagree about the required response status.",
      null
    )
    await storage.createRun(runningRun)

    // Act
    const terminal = await storage.finalizeRun(
      runningRun.id,
      duplicateOutput,
      recordedPatches(runningRun),
      "2026-09-13T12:00:01.000Z",
      SELECTED_JIRA_CRITERIA
    )

    // Assert
    expect(terminal).toMatchObject({
      run: { status: "invalid", findings: [], requirementCoverage: null },
      validation: {
        status: "invalid",
        errors: [
          'WEB-42: duplicate requirement conclusions for "Unauthorized access returns 403." are invalid',
        ],
      },
    })
    expect(await storage.loadRun(runningRun.id)).toEqual(terminal.run)
  })

  it("authoritative_then_conflicting_duplicate_requirement_conclusions_are_invalid", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const runningRun = createRunningRun({ id: "authoritative-first-duplicate-run" })
    const duplicateOutput = createDuplicateRequirementOutput(
      null,
      "Jira comments disagree about the required response status."
    )
    await storage.createRun(runningRun)

    // Act
    const terminal = await storage.finalizeRun(
      runningRun.id,
      duplicateOutput,
      recordedPatches(runningRun),
      "2026-09-13T12:00:01.000Z",
      SELECTED_JIRA_CRITERIA
    )

    // Assert
    expect(terminal).toMatchObject({
      run: { status: "invalid", findings: [], requirementCoverage: null },
      validation: {
        status: "invalid",
        errors: [
          'WEB-42: duplicate requirement conclusions for "Unauthorized access returns 403." are invalid',
        ],
      },
    })
    expect(await storage.loadRun(runningRun.id)).toEqual(terminal.run)
  })

  it("concurrent_factories_preserve_same_and_different_record_indexes", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const firstFactory = createAiReviewRunStorage(store)
    const secondFactory = createAiReviewRunStorage(store)
    const sameRun = createRunningRun()
    const differentRun = createRunningRun({ id: "run-2" })
    const anotherRun = createRunningRun({ id: "run-3" })

    // Act
    const sameIdResults = await Promise.allSettled([
      firstFactory.createRun(sameRun),
      secondFactory.createRun(sameRun),
    ])
    await Promise.all([firstFactory.createRun(differentRun), secondFactory.createRun(anotherRun)])

    // Assert
    expect(sameIdResults.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(sameIdResults.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await createAiReviewRunStorage(store).listRuns()).toEqual([
      sameRun,
      differentRun,
      anotherRun,
    ])
  })

  it("startup_marks_only_owned_running_reviews_interrupted", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const abandonedRun = createRunningRun({ id: "abandoned-run" })
    const completedRun = createCompletedRun({ id: "completed-run" })
    const completedBeforeRecovery = createRunningRun({ id: completedRun.id })
    await storage.createRun(abandonedRun)
    await storage.createRun(completedBeforeRecovery)
    await storage.finalizeRun(
      completedRun.id,
      outputFromRun(completedRun),
      recordedPatches(completedBeforeRecovery),
      completedRun.completedAt ?? "2026-09-13T12:00:01.000Z"
    )

    // Act
    const interrupted = await storage.recoverInterruptedRuns("2026-09-13T12:05:00.000Z")

    // Assert
    expect(interrupted).toEqual([
      expect.objectContaining({
        id: abandonedRun.id,
        status: "interrupted",
        completedAt: "2026-09-13T12:05:00.000Z",
      }),
    ])
    expect(await storage.loadRun(abandonedRun.id)).toMatchObject({ status: "interrupted" })
    expect(await storage.loadRun(completedRun.id)).toEqual(completedRun)
  })

  it("queued_snapshot_save_cannot_recreate_deleted_run_snapshot", async () => {
    // Arrange
    const savedThenDeletedStore = createMemoryKeyValueStore()
    const savedThenDeletedRuns = createAiReviewRunStorage(savedThenDeletedStore)
    const savedThenDeletedSnapshots = createJiraSnapshotStorage(savedThenDeletedStore)
    const savedThenDeletedRun = createRunningRun()
    const savedThenDeletedSnapshot = createJiraSnapshot()
    await savedThenDeletedRuns.createRun(savedThenDeletedRun)

    const deletedThenSavedStore = createMemoryKeyValueStore()
    const deletedThenSavedRuns = createAiReviewRunStorage(deletedThenSavedStore)
    const deletedThenSavedSnapshots = createJiraSnapshotStorage(deletedThenSavedStore)
    const deletedThenSavedRun = createRunningRun()
    const deletedThenSavedSnapshot = createJiraSnapshot()
    await deletedThenSavedRuns.createRun(deletedThenSavedRun)

    // Act
    const saveBeforeDelete = savedThenDeletedSnapshots.saveSnapshot(savedThenDeletedSnapshot)
    const deleteAfterSave = savedThenDeletedRuns.deleteRun(savedThenDeletedRun.id)
    await Promise.all([saveBeforeDelete, deleteAfterSave])

    const deleteBeforeSave = deletedThenSavedRuns.deleteRun(deletedThenSavedRun.id)
    const saveAfterDelete = deletedThenSavedSnapshots.saveSnapshot(deletedThenSavedSnapshot)
    await deleteBeforeSave

    // Assert
    expect(await savedThenDeletedSnapshots.loadSnapshot(savedThenDeletedSnapshot.id)).toBeNull()
    expect(await savedThenDeletedSnapshots.listSnapshots()).toEqual([])
    expect(await savedThenDeletedStore.get("ai-review:jira:snapshot-ids")).toBe("[]")
    await expect(saveAfterDelete).rejects.toThrow("AI review run run-1 has been deleted")
    expect(await deletedThenSavedSnapshots.loadSnapshot(deletedThenSavedSnapshot.id)).toBeNull()
    expect(await deletedThenSavedSnapshots.listSnapshots()).toEqual([])
    expect(await deletedThenSavedStore.get("ai-review:jira:snapshot-ids")).toBeNull()
  })

  it("admission_acknowledgement_generation_guarded_storage_recovers_unstarted_terminal_work", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const runningRun = createRunningRun({ id: "admission-guarded-run" })
    let currentGeneration = true

    // Act
    await storage.createRun(runningRun, () => currentGeneration)
    currentGeneration = false
    const staleTerminal = storage.terminateRun(
      runningRun.id,
      "cancelled",
      "2026-09-13T12:00:01.000Z",
      () => currentGeneration
    )

    // Assert
    await expect(staleTerminal).rejects.toThrow("stale for this generation")
    expect((await storage.loadRun(runningRun.id))?.status).toBe("running")
    expect(
      (await storage.recoverInterruptedRuns("2026-09-13T12:00:02.000Z")).find(
        (run) => run.id === runningRun.id
      )?.status
    ).toBe("interrupted")
  })

  it("terminal_transition_rechecks_generation_inside_the_serialized_write_boundary", async () => {
    // Arrange
    const backingStore = createMemoryKeyValueStore()
    const runningRun = createRunningRun({ id: "terminal-generation-recheck" })
    let currentGeneration = true
    let terminalRunReads = 0
    const storage = createAiReviewRunStorage({
      get: async (key) => {
        const value = await backingStore.get(key)
        if (key === "ai-review:run:terminal-generation-recheck") {
          terminalRunReads += 1
          if (terminalRunReads === 2) currentGeneration = false
        }
        return value
      },
      set: (key, value) => backingStore.set(key, value),
      delete: (key) => backingStore.delete(key),
    })
    await storage.createRun(runningRun)
    terminalRunReads = 0

    // Act
    const terminal = storage.terminateRun(
      runningRun.id,
      "failed",
      "2026-09-13T12:00:01.000Z",
      () => currentGeneration
    )

    // Assert
    await expect(terminal).rejects.toThrow("stale for this generation")
    expect(await storage.loadRun(runningRun.id)).toMatchObject({ status: "running" })
  })

  it("deleting_run_removes_associated_jira_snapshots", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createAiReviewRunStorage(store)
    const jiraSnapshots = createJiraSnapshotStorage(store)
    const completedRun = createCompletedRun()
    const jiraSnapshot = createJiraSnapshot()
    const permittedDiagnostics: PersistedAiReviewDiagnostics = {
      runId: completedRun.id,
      sanitizedEvents: [{ type: "progress", runId: completedRun.id, message: "Reviewing route" }],
      rawModelOutputPermitted: false,
      rawModelOutput: null,
    }
    const runningRun = createRunningRun()
    await storage.createRun(runningRun)
    await storage.finalizeRun(
      runningRun.id,
      outputFromRun(completedRun),
      recordedPatches(runningRun),
      completedRun.completedAt ?? "2026-09-13T12:00:01.000Z"
    )
    await storage.saveDisposition(createOpenDisposition())
    await storage.saveDiagnostics(permittedDiagnostics)
    await jiraSnapshots.saveSnapshot(jiraSnapshot)

    // Act
    const deletion = await storage.deleteRun(completedRun.id)

    // Assert
    expect(await storage.loadRun(completedRun.id)).toBeNull()
    expect(await storage.loadDispositions(completedRun.id)).toEqual([])
    expect(await storage.loadDiagnostics(completedRun.id)).toBeNull()
    expect(await jiraSnapshots.loadSnapshot(jiraSnapshot.id)).toBeNull()
    expect(await jiraSnapshots.listSnapshots()).toEqual([])
    expect(await store.get("ai-review:jira:snapshot-ids")).toBe("[]")
    expect(await store.get("ai-review:jira:snapshot:jira-snapshot-1")).toBeNull()
    expect(deletion).toEqual({
      appOwnedDataDeleted: true,
      providerOwnedData: {
        status: "not-controlled",
        message:
          "Provider-owned sessions, logs, caches, and remote data are outside PR Visualizer storage and require provider-specific cleanup guidance.",
      },
    })
  })
})
