import type {
  AiChatMessage,
  AiChatThread,
  AiReviewTarget,
  AiSavedChatFinding,
} from "@pr-visulizer/shared"
import {
  aiChatMessageSchema,
  aiChatThreadSchema,
  aiSavedChatFindingSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

import { validateFindingAnchors } from "@/utils/aiReview/findingValidation"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import { serializeStorageMutation } from "./storageMutationQueue"

const THREAD_IDS_KEY = "ai-review:chat:thread-ids"
const SAVED_FINDING_IDS_KEY = "ai-review:chat:saved-finding-ids"

export type ChatHistoryMessage = {
  message: AiChatMessage
  context: "current" | "historical"
}

export type ChatHistoryRebuild = {
  sessionCompatibility: "compatible" | "fresh-required"
  messages: ChatHistoryMessage[]
  omittedMessageIds: string[]
}

export type ChatHistoryRebuildInput = {
  contextSecurityFingerprint: string
  permittedHistoricalMessageIds: readonly string[]
}

// App-owned consent/identity generations are checked within the storage serialization boundary,
// not only in the caller, so delayed preparation cannot append a stale thread or message.
export type AiChatStorageGenerationGuard = () => boolean

function requireCurrentGeneration(guard: AiChatStorageGenerationGuard | undefined): void {
  if (guard && !guard())
    throw new Error("The chat finding validation is stale for the current identity")
}

function threadKey(threadId: string): string {
  return `ai-review:chat:thread:${encodeURIComponent(threadId)}`
}

function messageIdsKey(threadId: string): string {
  return `ai-review:chat:thread:${encodeURIComponent(threadId)}:message-ids`
}

function messageKey(threadId: string, messageId: string): string {
  return `ai-review:chat:thread:${encodeURIComponent(threadId)}:message:${encodeURIComponent(messageId)}`
}

function savedFindingKey(findingId: string): string {
  return `ai-review:chat:saved-finding:${encodeURIComponent(findingId)}`
}

function compareByCreatedAtAndId<T extends { createdAt: string; id: string }>(
  left: T,
  right: T
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function hasSameTarget(left: AiReviewTarget, right: AiReviewTarget): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.number === right.number
}

// A target-scoped reload is local history only, never a provider-session resume. Always choose
// the same persisted thread after identity reset rather than retaining an in-memory selection.
export function selectReloadedChatThread(
  threads: readonly AiChatThread[],
  target: AiReviewTarget
): AiChatThread | null {
  return (
    threads
      .filter((thread) => hasSameTarget(thread.target, target))
      .sort(compareByCreatedAtAndId)[0] ?? null
  )
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

async function loadThreadIds(store: KeyValueStore): Promise<string[]> {
  return (await loadValidated(store, THREAD_IDS_KEY, z.array(z.string().min(1)))) ?? []
}

async function loadMessageIds(store: KeyValueStore, threadId: string): Promise<string[]> {
  return (await loadValidated(store, messageIdsKey(threadId), z.array(z.string().min(1)))) ?? []
}

async function loadSavedFindingIds(store: KeyValueStore): Promise<string[]> {
  return (await loadValidated(store, SAVED_FINDING_IDS_KEY, z.array(z.string().min(1)))) ?? []
}

async function loadRequiredThread(store: KeyValueStore, threadId: string): Promise<AiChatThread> {
  const thread = await loadValidated(store, threadKey(threadId), aiChatThreadSchema)
  if (!thread)
    throw new Error(`AI chat thread ${threadId} does not exist or is invalid storage data`)

  return thread
}

// A process session is never persisted. Callers must explicitly decide which older messages are
// still permitted after evaluating the current disclosure policy; this pure core then labels them
// historical and keeps ordering stable for a deterministic fresh-session rebuild.
export function rebuildChatHistory(
  thread: AiChatThread,
  messages: readonly AiChatMessage[],
  input: ChatHistoryRebuildInput
): ChatHistoryRebuild {
  const parsedThread = aiChatThreadSchema.parse(thread)
  const parsedMessages = messages.map((message) => aiChatMessageSchema.parse(message))
  if (parsedMessages.some((message) => message.threadId !== parsedThread.id)) {
    throw new Error("AI chat history contains a message for a different thread")
  }

  const permittedHistoricalMessageIds = new Set(input.permittedHistoricalMessageIds)
  const history: ChatHistoryMessage[] = []
  const omittedMessageIds: string[] = []

  for (const message of [...parsedMessages].sort(compareByCreatedAtAndId)) {
    if (message.contextSecurityFingerprint === input.contextSecurityFingerprint) {
      history.push({ message, context: "current" })
    } else if (permittedHistoricalMessageIds.has(message.id)) {
      history.push({ message, context: "historical" })
    } else {
      omittedMessageIds.push(message.id)
    }
  }

  return {
    sessionCompatibility:
      parsedThread.contextSecurityFingerprint === input.contextSecurityFingerprint
        ? "compatible"
        : "fresh-required",
    messages: history,
    omittedMessageIds,
  }
}

export function createAiChatStorage(store: KeyValueStore) {
  const mutate = <T>(mutation: () => Promise<T>): Promise<T> =>
    serializeStorageMutation(store, mutation)
  const loadThread = (threadId: string): Promise<AiChatThread | null> =>
    loadValidated(store, threadKey(threadId), aiChatThreadSchema)
  const loadSavedFinding = (findingId: string): Promise<AiSavedChatFinding | null> =>
    loadValidated(store, savedFindingKey(findingId), aiSavedChatFindingSchema)

  const listThreads = async (target?: AiReviewTarget): Promise<AiChatThread[]> => {
    const threadIds = await loadThreadIds(store)
    const threads = await Promise.all(threadIds.map(loadThread))
    const validThreads = threads.filter((thread): thread is AiChatThread => thread !== null)

    return validThreads
      .filter((thread) => !target || hasSameTarget(thread.target, target))
      .sort(compareByCreatedAtAndId)
  }

  return {
    loadThread,
    loadSavedFinding,
    listThreads,

    async listSavedFindings(target?: AiReviewTarget): Promise<AiSavedChatFinding[]> {
      const findingIds = await loadSavedFindingIds(store)
      const findings = await Promise.all(findingIds.map(loadSavedFinding))
      const validFindings = findings.filter(
        (finding): finding is AiSavedChatFinding => finding !== null
      )
      if (!target) return validFindings

      const threads = await Promise.all(
        validFindings.map((finding) => loadThread(finding.threadId))
      )
      return validFindings.filter((finding, index) => {
        const thread = threads[index]
        return thread !== null && thread !== undefined && hasSameTarget(thread.target, target)
      })
    },

    createThread(
      thread: AiChatThread,
      generationGuard?: AiChatStorageGenerationGuard
    ): Promise<AiChatThread> {
      return mutate(async () => {
        requireCurrentGeneration(generationGuard)
        const parsedThread = aiChatThreadSchema.parse(thread)
        if (await store.get(threadKey(parsedThread.id))) {
          throw new Error(`AI chat thread ${parsedThread.id} already exists and is immutable`)
        }

        if (parsedThread.kind === "main") {
          const existingMainThread = (await listThreads(parsedThread.target)).find(
            (storedThread) => storedThread.kind === "main"
          )
          if (existingMainThread) {
            throw new Error(
              `AI chat already has a main thread for ${parsedThread.target.owner}/${parsedThread.target.repo}#${parsedThread.target.number}`
            )
          }
        }

        requireCurrentGeneration(generationGuard)
        await store.set(threadKey(parsedThread.id), JSON.stringify(parsedThread))
        const threadIds = await loadThreadIds(store)
        if (!threadIds.includes(parsedThread.id)) {
          requireCurrentGeneration(generationGuard)
          await store.set(THREAD_IDS_KEY, JSON.stringify([...threadIds, parsedThread.id]))
        }

        return parsedThread
      })
    },

    async listMessages(threadId: string): Promise<AiChatMessage[]> {
      await loadRequiredThread(store, threadId)
      const messageIds = await loadMessageIds(store, threadId)
      const messages = await Promise.all(
        messageIds.map((messageId) =>
          loadValidated(store, messageKey(threadId, messageId), aiChatMessageSchema)
        )
      )

      return messages
        .filter(
          (message): message is AiChatMessage => message !== null && message.threadId === threadId
        )
        .sort(compareByCreatedAtAndId)
    },

    appendMessage(
      message: AiChatMessage,
      generationGuard?: AiChatStorageGenerationGuard
    ): Promise<AiChatMessage> {
      return mutate(async () => {
        requireCurrentGeneration(generationGuard)
        const parsedMessage = aiChatMessageSchema.parse(message)
        await loadRequiredThread(store, parsedMessage.threadId)
        if (await store.get(messageKey(parsedMessage.threadId, parsedMessage.id))) {
          throw new Error(`AI chat message ${parsedMessage.id} already exists and is immutable`)
        }

        requireCurrentGeneration(generationGuard)
        await store.set(
          messageKey(parsedMessage.threadId, parsedMessage.id),
          JSON.stringify(parsedMessage)
        )
        const messageIds = await loadMessageIds(store, parsedMessage.threadId)
        if (!messageIds.includes(parsedMessage.id)) {
          requireCurrentGeneration(generationGuard)
          await store.set(
            messageIdsKey(parsedMessage.threadId),
            JSON.stringify([...messageIds, parsedMessage.id])
          )
        }

        return parsedMessage
      })
    },

    saveFinding(
      finding: AiSavedChatFinding,
      isCurrentIdentity: AiChatStorageGenerationGuard = () => true
    ): Promise<AiSavedChatFinding> {
      return mutate(async () => {
        requireCurrentGeneration(isCurrentIdentity)
        if (!isCurrentIdentity()) {
          throw new Error("The chat finding validation is stale for the current identity")
        }
        const parsedFinding = aiSavedChatFindingSchema.parse(finding)
        await loadRequiredThread(store, parsedFinding.threadId)
        const message = await loadValidated(
          store,
          messageKey(parsedFinding.threadId, parsedFinding.messageId),
          aiChatMessageSchema
        )
        if (!message || message.role !== "assistant" || message.findingCandidate === null) {
          throw new Error("A saved chat finding must reference an assistant finding candidate")
        }
        if (JSON.stringify(message.findingCandidate) !== JSON.stringify(parsedFinding.finding)) {
          throw new Error(
            "A saved chat finding must match its immutable assistant finding candidate"
          )
        }
        if (message.recordedPatchSnapshot === null) {
          throw new Error(
            "A saved chat finding requires the assistant turn's exact revision-pinned patch snapshot"
          )
        }
        const anchors = validateFindingAnchors(
          [parsedFinding.finding],
          message.recordedPatchSnapshot.patches
        )
        if (!anchors.valid) {
          throw new Error(
            `A saved chat finding must match the assistant turn's recorded patch: ${anchors.errors.map((error) => error.reason).join(" ")}`
          )
        }
        if (await store.get(savedFindingKey(parsedFinding.id))) {
          throw new Error(`Saved chat finding ${parsedFinding.id} is immutable`)
        }
        if (!isCurrentIdentity()) {
          throw new Error("The chat finding validation is stale for the current identity")
        }

        requireCurrentGeneration(isCurrentIdentity)
        await store.set(savedFindingKey(parsedFinding.id), JSON.stringify(parsedFinding))
        const findingIds = await loadSavedFindingIds(store)
        if (!findingIds.includes(parsedFinding.id)) {
          requireCurrentGeneration(isCurrentIdentity)
          await store.set(SAVED_FINDING_IDS_KEY, JSON.stringify([...findingIds, parsedFinding.id]))
        }

        return parsedFinding
      })
    },
  }
}

export type AiChatStorage = ReturnType<typeof createAiChatStorage>
