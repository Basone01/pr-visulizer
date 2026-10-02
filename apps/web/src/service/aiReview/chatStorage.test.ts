import type { AiChatMessage, AiChatThread } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { createAiChatStorage, rebuildChatHistory, selectReloadedChatThread } from "./chatStorage"

const TARGET = { owner: "acme", repo: "web", number: 42 }
const ORIGINAL_FINGERPRINT = "context-security-original"
const CURRENT_FINGERPRINT = "context-security-current"

function createMainThread(overrides: Partial<AiChatThread> = {}): AiChatThread {
  return {
    id: "main-thread",
    target: TARGET,
    baseSha: "base-sha",
    headSha: "head-sha",
    kind: "main",
    focusedContext: null,
    contextSecurityFingerprint: ORIGINAL_FINGERPRINT,
    createdAt: "2026-09-14T12:00:00.000Z",
    ...overrides,
  }
}

function recordedSnapshot(
  attachedContext: AiChatMessage["attachedContext"] = {
    scope: "file",
    path: "src/routes/account.ts",
  },
  contextSecurityFingerprint = ORIGINAL_FINGERPRINT
) {
  return {
    baseSha: "base-sha",
    headSha: "head-sha",
    attachedContext,
    contextSecurityFingerprint,
    disclosedFinding: null,
    patches: { "src/routes/account.ts": "@@ -0,0 +1,1 @@\n+protected route" },
  }
}

function createMessage(overrides: Partial<AiChatMessage> = {}): AiChatMessage {
  return {
    id: "message-1",
    threadId: "main-thread",
    role: "user",
    content: "Does this route preserve authorization?",
    attachedContext: { scope: "file", path: "src/routes/account.ts" },
    findingCandidate: null,
    contextSecurityFingerprint: ORIGINAL_FINGERPRINT,
    createdAt: "2026-09-14T12:01:00.000Z",
    ...overrides,
    recordedPatchSnapshot: overrides.recordedPatchSnapshot ?? null,
  }
}

describe("AI chat storage", () => {
  it("persists one provider-neutral main PR thread, focused threads, and attached context references", async () => {
    // Arrange
    const storage = createAiChatStorage(createMemoryKeyValueStore())
    const mainThread = createMainThread()
    const focusedThread: AiChatThread = {
      ...createMainThread({
        id: "finding-thread",
        kind: "focused",
        focusedContext: { scope: "finding", runId: "run-1", findingId: "finding-4" },
        createdAt: "2026-09-14T12:00:01.000Z",
      }),
    }
    const assistantMessage = createMessage({
      id: "message-2",
      threadId: focusedThread.id,
      role: "assistant",
      attachedContext: { scope: "finding", runId: "run-1", findingId: "finding-4" },
      createdAt: "2026-09-14T12:01:01.000Z",
    })

    // Act
    await storage.createThread(mainThread)
    await storage.createThread(focusedThread)
    await storage.appendMessage(assistantMessage)
    const duplicateMainThread = storage.createThread(
      createMainThread({ id: "second-main", createdAt: "2026-09-14T12:00:02.000Z" })
    )

    // Assert
    await expect(duplicateMainThread).rejects.toThrow("already has a main thread")
    expect(await storage.listThreads(TARGET)).toEqual([mainThread, focusedThread])
    expect(await storage.listMessages(focusedThread.id)).toEqual([assistantMessage])
  })

  it("requires a fresh session on a changed context fingerprint and rebuilds only permitted historical messages", () => {
    // Arrange
    const thread = createMainThread()
    const omittedMessage = createMessage({
      id: "message-older",
      createdAt: "2026-09-14T12:00:01.000Z",
    })
    const permittedHistoricalMessage = createMessage({
      id: "message-permitted",
      role: "assistant",
      createdAt: "2026-09-14T12:00:02.000Z",
    })
    const currentMessage = createMessage({
      id: "message-current",
      contextSecurityFingerprint: CURRENT_FINGERPRINT,
      createdAt: "2026-09-14T12:00:03.000Z",
    })

    // Act
    const rebuilt = rebuildChatHistory(
      thread,
      [currentMessage, permittedHistoricalMessage, omittedMessage],
      {
        contextSecurityFingerprint: CURRENT_FINGERPRINT,
        permittedHistoricalMessageIds: [permittedHistoricalMessage.id],
      }
    )

    // Assert
    expect(rebuilt).toEqual({
      sessionCompatibility: "fresh-required",
      messages: [
        { message: permittedHistoricalMessage, context: "historical" },
        { message: currentMessage, context: "current" },
      ],
      omittedMessageIds: [omittedMessage.id],
    })
  })

  it("saves only an immutable assistant finding candidate as a formal chat finding", async () => {
    // Arrange
    const storage = createAiChatStorage(createMemoryKeyValueStore())
    const mainThread = createMainThread()
    const candidate = {
      id: "chat-finding-1",
      title: "Require an authorization test",
      severity: "medium" as const,
      confidence: "high" as const,
      category: "tests",
      path: null,
      side: null,
      startLine: null,
      endLine: null,
      evidence: "The chat response identifies no authorization regression test.",
      impact: "Authorization behavior may regress unnoticed.",
      suggestedFix: "Add a focused authorization test.",
      source: "chat" as const,
    }
    const assistantMessage = createMessage({
      id: "assistant-candidate",
      role: "assistant",
      findingCandidate: candidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    await storage.createThread(mainThread)
    await storage.appendMessage(assistantMessage)

    // Act
    const saved = await storage.saveFinding({
      id: "saved-chat-finding-1",
      threadId: mainThread.id,
      messageId: assistantMessage.id,
      finding: candidate,
      savedAt: "2026-09-14T12:02:00.000Z",
    })
    const rewritten = storage.saveFinding({ ...saved, savedAt: "2026-09-14T12:03:00.000Z" })

    // Assert
    expect(await storage.listSavedFindings(TARGET)).toEqual([saved])
    await expect(rewritten).rejects.toThrow("immutable")
  })

  it("rejects a saved anchored candidate that is absent from its assistant turn patch snapshot", async () => {
    // Arrange
    const storage = createAiChatStorage(createMemoryKeyValueStore())
    const mainThread = createMainThread()
    const candidate = {
      id: "snapshot-mismatch",
      title: "The newer display line must not authorize this save",
      severity: "medium" as const,
      confidence: "high" as const,
      category: "tests",
      path: "src/routes/account.ts",
      side: "RIGHT" as const,
      startLine: 2,
      endLine: 2,
      evidence: "Only a later display patch contains line two.",
      impact: "A stale anchor could be saved.",
      suggestedFix: null,
      source: "chat" as const,
    }
    const assistantMessage = createMessage({
      id: "snapshot-mismatch-message",
      role: "assistant",
      findingCandidate: candidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    await storage.createThread(mainThread)
    await storage.appendMessage(assistantMessage)

    // Act
    const save = storage.saveFinding({
      id: "saved-snapshot-mismatch",
      threadId: mainThread.id,
      messageId: assistantMessage.id,
      finding: candidate,
      savedAt: "2026-09-14T12:02:00.000Z",
    })

    // Assert
    await expect(save).rejects.toThrow("recorded patch")
    expect(await storage.listSavedFindings(TARGET)).toEqual([])
  })

  it("rejects_snapshot_whose_scope_or_provenance_differs_from_the_assistant_turn", async () => {
    // Arrange
    const storage = createAiChatStorage(createMemoryKeyValueStore())
    const mainThread = createMainThread()
    const message = createMessage({
      id: "scope-provenance-mismatch",
      role: "assistant",
      findingCandidate: null,
      recordedPatchSnapshot: recordedSnapshot({ scope: "whole-pr" }, CURRENT_FINGERPRINT),
    })
    await storage.createThread(mainThread)

    // Act
    const append = storage.appendMessage(message)

    // Assert
    await expect(append).rejects.toThrow(
      "Assistant patch snapshots must match the turn's attached scope and security provenance"
    )
    expect(await storage.listMessages(mainThread.id)).toEqual([])
  })

  it("identity_invalidated_before_save_cannot_persist_a_validated_turn_candidate", async () => {
    // Arrange
    const storage = createAiChatStorage(createMemoryKeyValueStore())
    const mainThread = createMainThread()
    const candidate = {
      id: "identity-invalidated",
      title: "The generation changed before this candidate could save",
      severity: "medium" as const,
      confidence: "high" as const,
      category: "tests",
      path: null,
      side: null,
      startLine: null,
      endLine: null,
      evidence: "The earlier turn is otherwise valid.",
      impact: "A stale advisory finding could persist.",
      suggestedFix: null,
      source: "chat" as const,
    }
    const assistantMessage = createMessage({
      id: "identity-invalidated-message",
      role: "assistant",
      findingCandidate: candidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    await storage.createThread(mainThread)
    await storage.appendMessage(assistantMessage)
    let currentIdentity = true

    // Act
    const save = storage.saveFinding(
      {
        id: "saved-identity-invalidated",
        threadId: mainThread.id,
        messageId: assistantMessage.id,
        finding: candidate,
        savedAt: "2026-09-14T12:02:00.000Z",
      },
      () => currentIdentity
    )
    currentIdentity = false

    // Assert
    await expect(save).rejects.toThrow("stale for the current identity")
    expect(await storage.listSavedFindings(TARGET)).toEqual([])
  })

  it("concurrent_factories_preserve_same_and_different_record_indexes", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const firstFactory = createAiChatStorage(store)
    const secondFactory = createAiChatStorage(store)
    const mainThread = createMainThread()
    const focusedThread = createMainThread({
      id: "focused-thread",
      kind: "focused",
      focusedContext: { scope: "file", path: "src/routes/account.ts" },
      createdAt: "2026-09-14T12:00:01.000Z",
    })
    const anotherFocusedThread = createMainThread({
      id: "focused-thread-2",
      kind: "focused",
      focusedContext: { scope: "file", path: "src/routes/billing.ts" },
      createdAt: "2026-09-14T12:00:02.000Z",
    })

    // Act
    const sameIdResults = await Promise.allSettled([
      firstFactory.createThread(mainThread),
      secondFactory.createThread(mainThread),
    ])
    await Promise.all([
      firstFactory.createThread(focusedThread),
      secondFactory.createThread(anotherFocusedThread),
    ])

    // Assert
    expect(sameIdResults.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(sameIdResults.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await createAiChatStorage(store).listThreads(TARGET)).toEqual([
      mainThread,
      focusedThread,
      anotherFocusedThread,
    ])
  })

  it("selects a stable target-owned thread after identity-reset reload", async () => {
    // Arrange
    const mainThread = createMainThread({
      id: "main-thread",
      createdAt: "2026-09-14T12:00:02.000Z",
    })
    const focusedThread = createMainThread({
      id: "focused-thread",
      kind: "focused",
      focusedContext: { scope: "file", path: "src/routes/account.ts" },
      createdAt: "2026-09-14T12:00:01.000Z",
    })
    const otherTargetThread = createMainThread({
      id: "other-target-thread",
      target: { owner: "acme", repo: "other", number: 7 },
      createdAt: "2026-09-14T12:00:00.000Z",
    })

    // Act
    const selected = selectReloadedChatThread(
      [mainThread, focusedThread, otherTargetThread],
      TARGET
    )

    // Assert
    expect(selected).toEqual(focusedThread)
    expect(selectReloadedChatThread([], TARGET)).toBeNull()
  })

  it("keeps chat messages immutable and rejects messages for missing threads", async () => {
    // Arrange
    const storage = createAiChatStorage(createMemoryKeyValueStore())
    const mainThread = createMainThread()
    const firstMessage = createMessage()
    await storage.createThread(mainThread)

    // Act
    await storage.appendMessage(firstMessage)
    const rewrittenMessage = storage.appendMessage({
      ...firstMessage,
      content: "An attempt to rewrite a stored message.",
    })
    const missingThreadMessage = storage.appendMessage(
      createMessage({ id: "missing-thread-message", threadId: "missing-thread" })
    )

    // Assert
    await expect(rewrittenMessage).rejects.toThrow("already exists and is immutable")
    await expect(missingThreadMessage).rejects.toThrow("does not exist")
    expect(await storage.listMessages(mainThread.id)).toEqual([firstMessage])
  })
})
