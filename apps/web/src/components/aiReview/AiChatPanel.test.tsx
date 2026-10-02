import type { AiChatMessage, AiChatThread, AiFinding } from "@pr-visulizer/shared"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { type ComponentProps, StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { createAiChatStorage } from "@/service/aiReview/chatStorage"
import {
  type CodexReviewContext,
  createCodexReviewContext,
  createCodexSafeProfileChatPrompt,
} from "@/service/aiReview/codexReviewContext"
import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"
import type { TauriAiChatLifecycle } from "@/service/aiReview/tauriAiReviewClient"

import { AiChatPanel } from "./AiChatPanel"

const TARGET = { owner: "acme", repo: "webapp", number: 42 }
const BASE_SHA = "base-sha"
const HEAD_SHA = "head-sha"
const ORIGINAL_FINGERPRINT = "context-security-original"
const CURRENT_FINGERPRINT = "context-security-current"
const PATCH = ["@@ -0,0 +1,2 @@", "+first line", "+second line"].join("\n")

const observedProvenance = {
  executableIdentityDigest: "a".repeat(64),
  cliVersion: "0.153.4",
  helpDigest: "b".repeat(64),
  safeProfileRevision: "codex-safe-profile-r2",
  provenanceFingerprint: "c".repeat(64),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })

  return { promise, resolve, reject }
}

async function createCurrentContext(): Promise<CodexReviewContext> {
  return createCodexReviewContext({
    target: TARGET,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
    title: "Protect authorization",
    description: null,
    githubComments: [],
    selectedJiraSnapshots: [],
    effectiveInstructions: [],
    contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
    priorFeedback: { enabled: false, content: null },
    profile: "balanced",
    selectedModel: null,
    observedProvenance,
  })
}

function createThread(overrides: Partial<AiChatThread> = {}): AiChatThread {
  return {
    id: "main-thread",
    target: TARGET,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    kind: "main",
    focusedContext: null,
    contextSecurityFingerprint: ORIGINAL_FINGERPRINT,
    createdAt: "2026-09-14T12:00:00.000Z",
    ...overrides,
  }
}

function recordedSnapshot(
  patches: Record<string, string> = { "src/auth.ts": PATCH },
  baseSha = BASE_SHA,
  headSha = HEAD_SHA,
  attachedContext: AiChatMessage["attachedContext"] = { scope: "whole-pr" },
  contextSecurityFingerprint = ORIGINAL_FINGERPRINT
) {
  return {
    baseSha,
    headSha,
    attachedContext,
    contextSecurityFingerprint,
    disclosedFinding: null,
    patches,
  }
}

function createMessage(overrides: Partial<AiChatMessage> = {}): AiChatMessage {
  return {
    id: "message-1",
    threadId: "main-thread",
    role: "assistant",
    content: "A provider-neutral response.",
    attachedContext: { scope: "whole-pr" },
    findingCandidate: null,
    contextSecurityFingerprint: ORIGINAL_FINGERPRINT,
    createdAt: "2026-09-14T12:01:00.000Z",
    ...overrides,
    recordedPatchSnapshot: overrides.recordedPatchSnapshot ?? null,
  }
}

function candidate(overrides: Partial<AiFinding> = {}): AiFinding {
  return {
    id: "chat-finding",
    title: "Add an authorization regression test",
    severity: "medium",
    confidence: "high",
    category: "tests",
    path: "src/auth.ts",
    side: "RIGHT",
    startLine: 2,
    endLine: 2,
    evidence: "The changed authorization branch has no test.",
    impact: "Authorization regressions can reach users.",
    suggestedFix: "Add a focused branch test.",
    source: "chat",
    ...overrides,
  }
}

async function renderChat(
  messages: AiChatMessage[],
  options: {
    contextSecurityFingerprint?: string | null
    currentSelection?: boolean
    seedThread?: boolean
    createCodexSafeProfileChatContext?: (input: {
      profile: "quick" | "balanced" | "thorough"
      selectedModel: string | null
    }) => Promise<{ context: CodexReviewContext }>
    startCodexSafeProfileChat?: NonNullable<
      ComponentProps<typeof AiChatPanel>["startCodexSafeProfileChat"]
    >
  } = {}
) {
  const storage = createMemoryKeyValueStore()
  const chatStorage = createAiChatStorage(storage)
  if (options.seedThread !== false) await chatStorage.createThread(createThread())
  for (const message of messages) {
    await chatStorage.appendMessage(message)
  }
  const rendered = render(
    <StrictMode>
      <AiChatPanel
        target={TARGET}
        storage={storage}
        baseSha={BASE_SHA}
        headSha={HEAD_SHA}
        currentFilePath="src/auth.ts"
        currentSelection={
          options.currentSelection === false
            ? null
            : { scope: "selection", path: "src/auth.ts", side: "RIGHT", startLine: 1, endLine: 2 }
        }
        contextSecurityFingerprint={
          "contextSecurityFingerprint" in options
            ? (options.contextSecurityFingerprint ?? null)
            : ORIGINAL_FINGERPRINT
        }
        observedProvenance={observedProvenance}
        currentProvider="codex"
        {...(options.createCodexSafeProfileChatContext
          ? { createCodexSafeProfileChatContext: options.createCodexSafeProfileChatContext }
          : {})}
        {...(options.startCodexSafeProfileChat
          ? {
              startCodexSafeProfileChat: options.startCodexSafeProfileChat as NonNullable<
                ComponentProps<typeof AiChatPanel>["startCodexSafeProfileChat"]
              >,
            }
          : {})}
      />
    </StrictMode>
  )

  await waitFor(() =>
    expect(screen.queryByText("Loading local chat history…")).not.toBeInTheDocument()
  )
  return { storage, unmount: rendered.unmount }
}

describe("AiChatPanel", () => {
  it("unavailable_provider_disables_chat_instead_of_silently_ignoring_send", async () => {
    // Arrange
    const startChat = vi.fn()
    render(
      <AiChatPanel
        target={TARGET}
        storage={createMemoryKeyValueStore()}
        baseSha={BASE_SHA}
        headSha={HEAD_SHA}
        currentFilePath="src/auth.ts"
        currentSelection={null}
        contextSecurityFingerprint={null}
        observedProvenance={null}
        currentProvider="claude"
        createCodexSafeProfileChatContext={async () => {
          throw new Error("Unavailable chat must not create context")
        }}
        startCodexSafeProfileChat={startChat}
      />
    )

    // Act
    await screen.findByText(/Claude CLI is unavailable for chat/i)

    // Assert
    expect(screen.getByRole("textbox", { name: /Message/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    expect(startChat).not.toHaveBeenCalled()
  })

  it("context_assembly_keeps_chat_disabled_until_its_security_identity_is_ready", async () => {
    // Arrange
    render(
      <AiChatPanel
        target={TARGET}
        storage={createMemoryKeyValueStore()}
        baseSha={BASE_SHA}
        headSha={HEAD_SHA}
        currentFilePath="src/auth.ts"
        currentSelection={null}
        contextSecurityFingerprint={null}
        observedProvenance={observedProvenance}
        currentProvider="codex"
        createCodexSafeProfileChatContext={async () => {
          throw new Error("Context is still assembling")
        }}
      />
    )

    // Act
    await screen.findByText("Preparing the current PR context for chat…")

    // Assert
    expect(screen.getByRole("textbox", { name: /Message/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
  })

  it("attaches the exact lifted selection and visibly labels every persisted chat scope", async () => {
    // Arrange
    const messages = [
      createMessage({
        id: "selection-message",
        content: "Selection response",
        attachedContext: {
          scope: "selection",
          path: "src/auth.ts",
          side: "RIGHT",
          startLine: 1,
          endLine: 2,
        },
      }),
      createMessage({
        id: "file-message",
        content: "File response",
        attachedContext: { scope: "file", path: "src/auth.ts" },
      }),
      createMessage({
        id: "finding-message",
        content: "Finding response",
        attachedContext: { scope: "finding", runId: "run-1", findingId: "finding-1" },
      }),
      createMessage({ id: "pr-message", content: "PR response" }),
    ]

    // Act
    await renderChat(messages)
    await screen.findByText("Selection response")

    // Assert
    expect(
      screen.getByText("Attached: Selection: src/auth.ts (RIGHT lines 1–2)")
    ).toBeInTheDocument()
    expect(screen.getByText(/Attached: File: src\/auth.ts/i)).toBeInTheDocument()
    expect(screen.getByText(/Attached: Finding: finding-1/i)).toBeInTheDocument()
    expect(screen.getByText(/Attached: Whole PR/i)).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Current selection" })).not.toBeDisabled()
  })

  it("requires a fresh session and omits incompatible history from that session", async () => {
    // Arrange
    const oldMessage = createMessage({ content: "Do not send this old history to a new session." })

    // Act
    await renderChat([oldMessage], { contextSecurityFingerprint: CURRENT_FINGERPRINT })

    // Assert
    await waitFor(() =>
      expect(screen.getByText(/PR context changed/i)).toHaveTextContent(
        "Earlier messages aren't included. (1)"
      )
    )
    expect(screen.queryByText(oldMessage.content)).toBeNull()
  })

  it("chat_finding_save_uses_turn_recorded_revision_pinned_patch_not_display_patch", async () => {
    // Arrange
    const validCandidate = candidate()
    // A newer display patch could contain line three, but the assistant turn's exact admitted
    // snapshot contains only lines one and two and is the sole save authority.
    const invalidCandidate = candidate({ id: "invalid-anchor", startLine: 3, endLine: 3 })
    const validMessage = createMessage({
      id: "valid-candidate-message",
      content: "Validated candidate response",
      findingCandidate: validCandidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    const invalidMessage = createMessage({
      id: "invalid-candidate-message",
      content: "Invalid candidate response",
      findingCandidate: invalidCandidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    const { storage } = await renderChat([validMessage, invalidMessage])
    const user = userEvent.setup()

    // Act
    const saveButton = await screen.findByRole("button", { name: "Save as finding" })
    await user.click(saveButton)

    // Assert
    await waitFor(() =>
      expect(
        screen.getByText(
          "Saved as a validated advisory finding. It has not been published or drafted."
        )
      ).toBeInTheDocument()
    )
    expect(await createAiChatStorage(storage).listSavedFindings(TARGET)).toEqual([
      expect.objectContaining({ messageId: validMessage.id, finding: validCandidate }),
    ])
    expect(screen.getByText(/This finding candidate cannot be saved/i)).toHaveTextContent(
      "line 3 is not present"
    )
  })

  it("chat_candidate_with_side_and_no_path_is_not_saved", async () => {
    // Arrange
    const invalidCandidate = candidate({
      id: "side-without-path",
      path: null,
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
    })
    const invalidMessage = createMessage({
      id: "side-without-path-message",
      content: "A side-present candidate without a path.",
      findingCandidate: invalidCandidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    const { storage } = await renderChat([invalidMessage])

    // Act
    const warning = await screen.findByText(/This finding candidate cannot be saved/i)

    // Assert
    expect(warning).toHaveTextContent("Anchored findings require a path")
    expect(screen.queryByRole("button", { name: "Save as finding" })).toBeNull()
    expect(await createAiChatStorage(storage).listSavedFindings(TARGET)).toEqual([])
  })

  it("sends_chat_directly_after_readiness_without_a_consent_gate", async () => {
    // Arrange
    const context = await createCodexReviewContext({
      target: TARGET,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
      title: "Protect authorization",
      description: null,
      githubComments: [],
      selectedJiraSnapshots: [],
      effectiveInstructions: [],
      contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
      priorFeedback: { enabled: false, content: null },
      profile: "balanced",
      selectedModel: null,
      observedProvenance,
    })
    const invalidCandidate = candidate({ id: "chat-invalid-anchor", startLine: 99, endLine: 99 })
    const lifecycle: TauriAiChatLifecycle = {
      runId: "codex-chat-run",
      completion: Promise.resolve({
        message: "I found a candidate with an invalid anchor.",
        findingCandidate: invalidCandidate,
        reportedModel: null,
        usage: {
          elapsedMs: 1,
          parentAgentCount: 1,
          nestedAgentCount: 0,
          toolEventCount: 0,
          approvedCommandCount: 0,
          inputTokens: null,
          outputTokens: null,
          providerCost: null,
        },
      }),
      cancel: vi.fn(async () => undefined),
    }
    const startChat = vi.fn((_input: unknown) => lifecycle)
    const { storage } = await renderChat([], {
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createCodexSafeProfileChatContext: async () => ({ context }),
      startCodexSafeProfileChat: startChat,
    })
    await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
    const user = userEvent.setup()

    // Act
    await user.type(screen.getByRole("textbox", { name: /Message/i }), "Is this safe?")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    // Assert
    await screen.findByText("I found a candidate with an invalid anchor.")
    const threads = await createAiChatStorage(storage).listThreads(TARGET)
    const persisted = await createAiChatStorage(storage).listMessages(threads[0]!.id)
    expect(persisted).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Is this safe?",
        attachedContext: expect.any(Object),
      }),
      expect.objectContaining({
        role: "assistant",
        findingCandidate: invalidCandidate,
        contextSecurityFingerprint: context.contextSecurityFingerprint,
      }),
    ])
    expect(startChat).toHaveBeenCalledOnce()
    expect(startChat.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        runId: expect.stringMatching(/^codex-chat-/),
        thread: expect.not.objectContaining({ sessionId: expect.anything() }),
        history: [],
      })
    )
    expect(screen.getByText(/This finding candidate cannot be saved/i)).toHaveTextContent(
      "line 99 is not present"
    )
  })

  it("shows_the_pending_message_and_real_lifecycle_activity_before_rendering_validated_markdown", async () => {
    // Arrange
    const context = await createCodexReviewContext({
      target: TARGET,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
      title: "Protect authorization",
      description: null,
      githubComments: [],
      selectedJiraSnapshots: [],
      effectiveInstructions: [],
      contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
      priorFeedback: { enabled: false, content: null },
      profile: "balanced",
      selectedModel: null,
      observedProvenance,
    })
    const contextPreparation = deferred<{ context: CodexReviewContext }>()
    const completion = deferred<Awaited<TauriAiChatLifecycle["completion"]>>()
    let emitEvent: ((event: { type: "progress"; runId: string; message: string }) => void) | null = null
    const startChat: NonNullable<ComponentProps<typeof AiChatPanel>["startCodexSafeProfileChat"]> =
      (input) => {
        emitEvent = input.onEvent ?? null
        return {
          runId: "codex-chat-run",
          admission: Promise.resolve(),
          completion: completion.promise,
          cancel: vi.fn(async () => undefined),
        }
      }
    const { storage } = await renderChat([], {
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createCodexSafeProfileChatContext: () => contextPreparation.promise,
      startCodexSafeProfileChat: startChat,
    })
    await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
    const user = userEvent.setup()

    // Act
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Explain the change")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    // Assert
    expect(screen.getByLabelText("Chat transcript")).toHaveTextContent("Explain the change")
    expect(screen.getByLabelText("Chat activity")).toHaveTextContent("Preparing context")

    // Act
    await act(async () => contextPreparation.resolve({ context }))
    await waitFor(() => expect(emitEvent).not.toBeNull())
    act(() => emitEvent?.({ type: "progress", runId: "codex-chat-run", message: "Reading diff" }))

    // Assert
    expect(screen.getByLabelText("Chat activity")).toHaveTextContent("Starting Codex")
    expect(screen.getByLabelText("Chat activity")).toHaveTextContent("Reading diff")

    // Act
    await act(async () =>
      completion.resolve({
        message: "## Result\n\n- **Safe** change\n\n```ts\nconst allowed = true\n```",
        findingCandidate: null,
        reportedModel: null,
        usage: {
          elapsedMs: 10,
          parentAgentCount: 1,
          nestedAgentCount: 0,
          toolEventCount: 1,
          approvedCommandCount: 0,
          inputTokens: null,
          outputTokens: null,
          providerCost: null,
        },
      })
    )

    // Assert
    expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument()
    expect(screen.getByText("Safe")).toBeInTheDocument()
    expect(screen.getByText("const allowed = true")).toBeInTheDocument()
  })

  it("pauses_auto_follow_when_the_reader_scrolls_up_and_jumps_to_the_latest_message_on_request", async () => {
    // Arrange
    await renderChat([createMessage()])
    const transcript = screen.getByLabelText("Chat transcript")
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    const user = userEvent.setup()

    // Act
    fireEvent.scroll(transcript)

    // Assert
    const jump = screen.getByRole("button", { name: "Jump to latest" })
    expect(jump).toBeInTheDocument()
    await user.click(jump)
    expect(transcript.scrollTop).toBe(1_000)
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument()
  })

  it("keeps_an_admitted_user_message_visible_when_the_provider_turn_fails", async () => {
    // Arrange
    const context = await createCodexReviewContext({
      target: TARGET,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
      title: "Protect authorization",
      description: null,
      githubComments: [],
      selectedJiraSnapshots: [],
      effectiveInstructions: [],
      contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
      priorFeedback: { enabled: false, content: null },
      profile: "balanced",
      selectedModel: null,
      observedProvenance,
    })
    const completion = deferred<Awaited<TauriAiChatLifecycle["completion"]>>()
    const { storage } = await renderChat([], {
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createCodexSafeProfileChatContext: async () => ({ context }),
      startCodexSafeProfileChat: () => ({
        runId: "codex-chat-run",
        admission: Promise.resolve(),
        completion: completion.promise,
        cancel: vi.fn(async () => undefined),
      }),
    })
    await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
    const user = userEvent.setup()
    const sentMessage = "Keep this admitted question"

    // Act
    await user.type(screen.getByRole("textbox", { name: "Message" }), sentMessage)
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() =>
      expect(screen.getByLabelText("Chat transcript")).toHaveTextContent(sentMessage)
    )
    await act(async () => completion.reject(new Error("Provider stopped")))

    // Assert
    await screen.findByText("Provider stopped")
    expect(screen.getByLabelText("Chat transcript")).toHaveTextContent(sentMessage)
    const threads = await createAiChatStorage(storage).listThreads(TARGET)
    const persisted = await createAiChatStorage(storage).listMessages(threads[0]!.id)
    expect(persisted).toEqual([
      expect.objectContaining({ role: "user", content: sentMessage }),
    ])
  })

  it("keeps_an_admitted_user_message_visible_when_the_turn_is_cancelled", async () => {
    // Arrange
    const context = await createCurrentContext()
    const completion = deferred<Awaited<TauriAiChatLifecycle["completion"]>>()
    const cancel = vi.fn(async () => completion.reject(new Error("cancelled")))
    const { storage } = await renderChat([], {
      contextSecurityFingerprint: context.contextSecurityFingerprint,
      createCodexSafeProfileChatContext: async () => ({ context }),
      startCodexSafeProfileChat: () => ({
        runId: "codex-chat-run",
        admission: Promise.resolve(),
        completion: completion.promise,
        cancel,
      }),
    })
    await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
    const user = userEvent.setup()
    const sentMessage = "Keep this cancelled question"

    // Act
    await user.type(screen.getByRole("textbox", { name: "Message" }), sentMessage)
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() =>
      expect(screen.getByLabelText("Chat transcript")).toHaveTextContent(sentMessage)
    )
    await user.click(screen.getByRole("button", { name: "Cancel chat" }))

    // Assert
    await screen.findByText("Codex safe-profile chat was cancelled. No model response was saved.")
    expect(cancel).toHaveBeenCalledOnce()
    expect(screen.getByLabelText("Chat transcript")).toHaveTextContent(sentMessage)
    const threads = await createAiChatStorage(storage).listThreads(TARGET)
    const persisted = await createAiChatStorage(storage).listMessages(threads[0]!.id)
    expect(persisted).toEqual([
      expect.objectContaining({ role: "user", content: sentMessage }),
    ])
  })

  it("nonfinding_chat_scope_never_discloses_selected_finding", async () => {
    // Arrange
    const context = await createCodexReviewContext({
      target: TARGET,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
      title: "Protect authorization",
      description: null,
      githubComments: [],
      selectedJiraSnapshots: [],
      effectiveInstructions: [],
      contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
      priorFeedback: { enabled: false, content: null },
      profile: "balanced",
      selectedModel: null,
      observedProvenance,
    })
    const historicalFinding = candidate({
      title: "Historical finding must not be disclosed",
      evidence: "Historical evidence must remain outside this scope.",
    })

    // Act
    const filePrompt = createCodexSafeProfileChatPrompt(context, {
      attachedContext: { scope: "file", path: "src/auth.ts" },
      message: "Review this file.",
      history: [],
      finding: historicalFinding,
    })
    const selectionPrompt = createCodexSafeProfileChatPrompt(context, {
      attachedContext: {
        scope: "selection",
        path: "src/auth.ts",
        side: "RIGHT",
        startLine: 1,
        endLine: 2,
      },
      message: "Review this selection.",
      history: [],
      finding: historicalFinding,
    })
    const wholePrPrompt = createCodexSafeProfileChatPrompt(context, {
      attachedContext: { scope: "whole-pr" },
      message: "Review this PR.",
      history: [],
      finding: historicalFinding,
    })
    const findingPrompt = createCodexSafeProfileChatPrompt(context, {
      attachedContext: { scope: "finding", runId: "current-run", findingId: historicalFinding.id },
      message: "Review this finding.",
      history: [],
      finding: historicalFinding,
    })

    // Assert
    for (const prompt of [filePrompt, selectionPrompt, wholePrPrompt]) {
      expect(prompt).not.toContain(historicalFinding.title)
      expect(prompt).not.toContain(historicalFinding.evidence)
    }
    expect(findingPrompt).toContain(historicalFinding.title)
    expect(findingPrompt).toContain(historicalFinding.evidence)
  })

  it("chat_preparation_resets_when_target_provider_or_security_identity_changes", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
    const context = await createCodexReviewContext({
      target: TARGET,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
      title: "Protect authorization",
      description: null,
      githubComments: [],
      selectedJiraSnapshots: [],
      effectiveInstructions: [],
      contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
      priorFeedback: { enabled: false, content: null },
      profile: "balanced",
      selectedModel: null,
      observedProvenance,
    })
    let resolveOutput: (value: Awaited<TauriAiChatLifecycle["completion"]>) => void = () =>
      undefined
    const completion = new Promise<Awaited<TauriAiChatLifecycle["completion"]>>((resolve) => {
      resolveOutput = resolve
    })
    const cancel = vi.fn(async () => undefined)
    const startChat = vi.fn(() => ({ runId: "codex-chat-run", completion, cancel }))
    const props = (next: {
      target: typeof TARGET
      provider: "claude" | "codex"
      fingerprint: string
    }) => (
      <AiChatPanel
        target={next.target}
        storage={storage}
        baseSha={BASE_SHA}
        headSha={HEAD_SHA}
        currentFilePath="src/auth.ts"
        currentSelection={null}
        contextSecurityFingerprint={next.fingerprint}
        observedProvenance={observedProvenance}
        currentProvider={next.provider}
        createCodexSafeProfileChatContext={async () => ({ context })}
        startCodexSafeProfileChat={
          startChat as NonNullable<ComponentProps<typeof AiChatPanel>["startCodexSafeProfileChat"]>
        }
      />
    )
    const rendered = render(
      props({ target: TARGET, provider: "codex", fingerprint: context.contextSecurityFingerprint })
    )
    const user = userEvent.setup()

    // Act
    await user.type(screen.getByRole("textbox", { name: /Message/i }), "Is this safe?")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(startChat).toHaveBeenCalledOnce())
    rendered.rerender(
      props({
        target: { owner: "acme", repo: "other-repo", number: 7 },
        provider: "claude",
        fingerprint: "changed-security-fingerprint",
      })
    )
    resolveOutput({
      message: "This stale completion must not append.",
      findingCandidate: null,
      reportedModel: null,
      usage: {
        elapsedMs: 1,
        parentAgentCount: 1,
        nestedAgentCount: 0,
        toolEventCount: 0,
        approvedCommandCount: 0,
        inputTokens: null,
        outputTokens: null,
        providerCost: null,
      },
    })

    // Assert
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await waitFor(async () => {
      const previousThreads = await createAiChatStorage(storage).listThreads(TARGET)
      expect(previousThreads).toHaveLength(1)
      await expect(
        createAiChatStorage(storage).listMessages(previousThreads[0]!.id)
      ).resolves.toEqual([expect.objectContaining({ role: "user", content: "Is this safe?" })])
    })
  })

  it("chat_identity_reset_reloads_and_reselects_target_thread_after_cancellation", async () => {
    // Arrange
    const storage = createMemoryKeyValueStore()
    const chatStorage = createAiChatStorage(storage)
    const mainThread = createThread()
    const focusedThread = createThread({
      id: "focused-thread",
      kind: "focused",
      focusedContext: { scope: "file", path: "src/auth.ts" },
      createdAt: "2026-09-14T12:00:01.000Z",
    })
    const persistedCandidate = candidate({ id: "persisted-candidate" })
    const persistedAssistant = createMessage({
      id: "persisted-assistant",
      content: "Persisted target-owned chat history.",
      findingCandidate: persistedCandidate,
      recordedPatchSnapshot: recordedSnapshot(),
    })
    await chatStorage.createThread(mainThread)
    await chatStorage.createThread(focusedThread)
    await chatStorage.appendMessage(persistedAssistant)
    await chatStorage.saveFinding({
      id: "main-thread:persisted-assistant:persisted-candidate",
      threadId: mainThread.id,
      messageId: persistedAssistant.id,
      finding: persistedCandidate,
      savedAt: "2026-09-14T12:02:00.000Z",
    })
    await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
    const context = await createCodexReviewContext({
      target: TARGET,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      recordedPatches: { baseSha: BASE_SHA, headSha: HEAD_SHA, patches: { "src/auth.ts": PATCH } },
      title: "Protect authorization",
      description: null,
      githubComments: [],
      selectedJiraSnapshots: [],
      effectiveInstructions: [],
      contextPolicy: { includedPaths: ["src/auth.ts"], excludedPaths: [], mode: "hard-exclusion" },
      priorFeedback: { enabled: false, content: null },
      profile: "balanced",
      selectedModel: null,
      observedProvenance,
    })
    let resolveOutput: (value: Awaited<TauriAiChatLifecycle["completion"]>) => void = () =>
      undefined
    const completion = new Promise<Awaited<TauriAiChatLifecycle["completion"]>>((resolve) => {
      resolveOutput = resolve
    })
    const cancel = vi.fn(async () => undefined)
    const startChat = vi.fn(() => ({ runId: "codex-chat-run", completion, cancel }))
    const props = (provider: "claude" | "codex") => (
      <AiChatPanel
        target={TARGET}
        storage={storage}
        baseSha={BASE_SHA}
        headSha={HEAD_SHA}
        currentFilePath="src/auth.ts"
        currentSelection={null}
        contextSecurityFingerprint={ORIGINAL_FINGERPRINT}
        observedProvenance={observedProvenance}
        currentProvider={provider}
        createCodexSafeProfileChatContext={async () => ({ context })}
        startCodexSafeProfileChat={
          startChat as NonNullable<ComponentProps<typeof AiChatPanel>["startCodexSafeProfileChat"]>
        }
      />
    )
    const rendered = render(props("codex"))
    const user = userEvent.setup()
    await screen.findByText(persistedAssistant.content)

    // Act
    await user.type(screen.getByRole("textbox", { name: /Message/i }), "Is this safe?")
    await user.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(startChat).toHaveBeenCalledOnce())
    rendered.rerender(props("claude"))
    resolveOutput({
      message: "This cancelled output must not be appended.",
      findingCandidate: null,
      reportedModel: null,
      usage: {
        elapsedMs: 1,
        parentAgentCount: 1,
        nestedAgentCount: 0,
        toolEventCount: 0,
        approvedCommandCount: 0,
        inputTokens: null,
        outputTokens: null,
        providerCost: null,
      },
    })

    // Assert
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conversation" })).toHaveValue(mainThread.id)
    )
    expect(await screen.findByText(persistedAssistant.content)).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Saved as finding" })).toBeDisabled()
    expect(screen.queryByText("This cancelled output must not be appended.")).toBeNull()
    expect(await chatStorage.listSavedFindings(TARGET)).toEqual([
      expect.objectContaining({ id: "main-thread:persisted-assistant:persisted-candidate" }),
    ])
  })

  it("every_chat_pre_admission_error_settles_idle_without_persisting_thread_or_message", async () => {
    // Each named failure is a pre-admission seam: the context factory fails before a lifecycle
    // exists, while every broker-facing seam rejects both lifecycle promises.
    const seams = [
      { name: "unavailable capability", lifecycleError: true },
      { name: "context failure", lifecycleError: false },
      { name: "listener failure", lifecycleError: true },
      { name: "start rejection", lifecycleError: true },
      { name: "cancellation", lifecycleError: true },
      { name: "receipt mismatch", lifecycleError: true },
    ]

    for (const seam of seams) {
      const error = new Error(seam.name)
      const start = vi.fn(() => {
        const admission = Promise.reject(error)
        const completion = Promise.reject(error)
        // This test intentionally supplies a rejected pre-admission lifecycle; the panel must
        // consume both settlements even though no user-visible turn is authorized to persist.
        void admission.catch(() => undefined)
        void completion.catch(() => undefined)
        return {
          runId: `failed-${seam.name.replaceAll(" ", "-")}`,
          admission,
          completion,
          cancel: vi.fn(async () => undefined),
        } satisfies TauriAiChatLifecycle
      })
      const { storage, unmount } = await renderChat([], {
        seedThread: false,
        contextSecurityFingerprint: ORIGINAL_FINGERPRINT,
        createCodexSafeProfileChatContext: async () => {
          if (!seam.lifecycleError) throw error
          return {
            context: await createCodexReviewContext({
              target: TARGET,
              baseSha: BASE_SHA,
              headSha: HEAD_SHA,
              recordedPatches: {
                baseSha: BASE_SHA,
                headSha: HEAD_SHA,
                patches: { "src/auth.ts": PATCH },
              },
              title: "Protect authorization",
              description: null,
              githubComments: [],
              selectedJiraSnapshots: [],
              effectiveInstructions: [],
              contextPolicy: {
                includedPaths: ["src/auth.ts"],
                excludedPaths: [],
                mode: "hard-exclusion",
              },
              priorFeedback: { enabled: false, content: null },
              profile: "balanced",
              selectedModel: null,
              observedProvenance,
            }),
          }
        },
        startCodexSafeProfileChat: start,
      })
      await createAiReviewSettingsStorage(storage).saveDefaultProvider("codex")
      const user = userEvent.setup()

      await user.type(screen.getByRole("textbox", { name: /Message/i }), "Retry me")
      await user.click(screen.getByRole("button", { name: "Send message" }))

      await screen.findByText(seam.name)
      expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled()
      expect(await createAiChatStorage(storage).listThreads(TARGET)).toEqual([])
      expect(start).toHaveBeenCalledTimes(seam.lifecycleError ? 1 : 0)
      unmount()
    }
  })

  it("keeps a prose-only chat response non-promotable", async () => {
    // Arrange
    const proseOnlyMessage = createMessage({ content: "This is advisory prose, not a finding." })

    // Act
    await renderChat([proseOnlyMessage])

    // Assert
    expect(await screen.findByText(proseOnlyMessage.content)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save as finding" })).toBeNull()
  })
})
