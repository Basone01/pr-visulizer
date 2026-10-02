import {
  codexSafeProfileChatTerminalSchema,
  codexSafeProfileReviewTerminalSchema,
} from "@pr-visulizer/shared"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createCodexSafeProfileBridge } from "./codexSafeProfileBridge"

const observedProvenance = {
  executableIdentityDigest: "a".repeat(64),
  cliVersion: "0.153.4",
  helpDigest: "b".repeat(64),
  safeProfileRevision: "codex-safe-profile-r2",
  provenanceFingerprint: "c".repeat(64),
}

describe("Codex safe-profile bridge", () => {
  it("camel_case_wire_events_and_cancel_request_round_trip", async () => {
    // Arrange
    let eventHandler: ((event: { payload: unknown }) => void) | null = null
    const unlisten = vi.fn()
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "codex_safe_profile_capability") {
        return {
          available: false,
          cliVersion: "0.153.4",
          coreControlsVerified: true,
          diagnostics: ["Codex safe-profile exact compatibility receipt was rejected."],
        }
      }
      if (command === "codex_safe_profile_start") {
        eventHandler?.({ payload: { type: "queued", runId: "codex-run-1" } })
        eventHandler?.({
          payload: {
            type: "admitted",
            runId: "codex-run-1",
            provenance: {
              executableIdentityDigest: "a".repeat(64),
              cliVersion: "0.153.4",
              helpDigest: "b".repeat(64),
              safeProfileRevision: "codex-safe-profile-r2",
              provenanceFingerprint: "c".repeat(64),
            },
          },
        })
        eventHandler?.({ payload: { type: "started", runId: "codex-run-1" } })
        eventHandler?.({ payload: { type: "progress", runId: "codex-run-1" } })
        eventHandler?.({
          payload: {
            type: "completed",
            runId: "codex-run-1",
            result: {
              summary: "Validated terminal result",
              findings: [],
              requirementCoverage: null,
              reportedModel: null,
            },
            usage: { elapsedMs: 42, toolEventCount: 0 },
            provenance: observedProvenance,
          },
        })
        return { runId: (args?.request as { runId: string }).runId }
      }
      if (command === "codex_safe_profile_cancel") return undefined
      throw new Error(`Unexpected command: ${command}`)
    })
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke,
        listen: async (_event, handler) => {
          eventHandler = handler
          return unlisten
        },
      })
    )
    const receivedEvents: string[] = []

    // Act
    const capability = await bridge.capability()
    const run = bridge.run(
      {
        runId: "codex-run-1",
        prKey: "acme/web#42",
        operation: "review",
        prompt: "App-owned minimal prompt",
        model: null,
        provenanceReceiptId: "test-receipt",
        observedProvenance,
      },
      z.object({ summary: z.string() }),
      (event) => {
        receivedEvents.push(event.type)
      }
    )
    const result = await run.completion
    await bridge.cancel("codex-run-1")

    // Assert
    expect(capability).toEqual({
      available: false,
      cliVersion: "0.153.4",
      coreControlsVerified: true,
      diagnostics: ["Codex safe-profile exact compatibility receipt was rejected."],
    })
    // The fixed review schema validates every model-owned field before this caller's narrower
    // result schema projects the value it requested.
    expect(result).toEqual({ summary: "Validated terminal result" })
    expect(receivedEvents).toEqual(["queued", "admitted", "started", "progress", "completed"])
    expect(invoke).toHaveBeenNthCalledWith(1, "codex_safe_profile_capability")
    expect(invoke).toHaveBeenNthCalledWith(2, "codex_safe_profile_start", {
      request: {
        runId: "codex-run-1",
        prKey: "acme/web#42",
        operation: "review",
        prompt: "App-owned minimal prompt",
        model: null,
        provenanceReceiptId: "test-receipt",
      },
    })
    expect(invoke).toHaveBeenNthCalledWith(3, "codex_safe_profile_cancel", {
      request: { runId: "codex-run-1" },
    })
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it("rejects capability provenance without its immutable executable help profile binding", async () => {
    // Arrange
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke: async () => ({
          available: false,
          cliVersion: "0.153.4",
          coreControlsVerified: true,
          provenance: {
            executableIdentityDigest: "a".repeat(64),
            cliVersion: "0.153.4",
            helpDigest: "b".repeat(64),
            safeProfileRevision: "codex-safe-profile-r2",
          },
          receiptId: "test-receipt",
          diagnostics: ["exact compatibility receipt was rejected"],
        }),
        listen: async () => () => undefined,
      })
    )

    // Act
    const capability = bridge.capability()

    // Assert
    await expect(capability).rejects.toThrow()
  })

  it("latched_cancellation_after_listener_registration_never_invokes_broker_start", async () => {
    // Arrange
    let cancelled = false
    const invoke = vi.fn(async () => ({ runId: "cancelled-before-admission" }))
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke,
        listen: async () => {
          cancelled = true
          return () => undefined
        },
      })
    )

    // Act
    const start = bridge.run(
      {
        runId: "cancelled-before-admission",
        prKey: "acme/web#42",
        operation: "review",
        prompt: "Bounded prompt",
        model: null,
        provenanceReceiptId: "test-receipt",
        observedProvenance,
        isCancelled: () => cancelled,
      },
      codexSafeProfileReviewTerminalSchema
    )

    // Assert
    await expect(start.admission).rejects.toThrow("cancelled before broker admission")
    await expect(start.completion).rejects.toThrow("cancelled before broker admission")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("public_fifo_dequeue_to_preparing_is_atomic_and_cancellation_latch_blocks_every_prestdin_boundary", async () => {
    // Arrange
    let eventHandler: ((event: { payload: unknown }) => void) | null = null
    const invoke = vi.fn(async (command: string) => {
      if (command === "codex_safe_profile_start") {
        eventHandler?.({ payload: { type: "queued", runId: "fifo-cancelled" } })
        return { runId: "fifo-cancelled" }
      }
      if (command === "codex_safe_profile_cancel") {
        eventHandler?.({
          payload: {
            type: "failed",
            runId: "fifo-cancelled",
            code: "cancelled",
            provenance: null,
          },
        })
        return undefined
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke,
        listen: async (_event, handler) => {
          eventHandler = handler
          return () => undefined
        },
      })
    )

    // Act
    const run = bridge.run(
      {
        runId: "fifo-cancelled",
        prKey: "acme/web#42",
        operation: "review",
        prompt: "Bounded prompt that must never reach stdin after cancellation.",
        model: null,
        provenanceReceiptId: "test-receipt",
        observedProvenance,
      },
      codexSafeProfileReviewTerminalSchema
    )
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("codex_safe_profile_start", expect.any(Object))
    })
    await bridge.cancel("fifo-cancelled")

    // Assert
    await expect(run.admission).rejects.toThrow("cancelled")
    await expect(run.completion).rejects.toThrow("cancelled")
    expect(invoke).toHaveBeenNthCalledWith(2, "codex_safe_profile_cancel", {
      request: { runId: "fifo-cancelled" },
    })
  })

  it("listener_start_and_admission_receipt_failures_reject_both_pre_admission_promises", async () => {
    // Arrange
    const request = {
      runId: "pre-admission-failure",
      prKey: "acme/web#42",
      operation: "chat" as const,
      prompt: "Bounded prompt",
      model: null,
      provenanceReceiptId: "test-receipt",
      observedProvenance,
    }
    const listenerFailure = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke: vi.fn(),
        listen: async () => {
          throw new Error("listener failure")
        },
      })
    ).run(request, codexSafeProfileChatTerminalSchema)
    const startFailure = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke: async () => {
          throw new Error("start rejection")
        },
        listen: async () => () => undefined,
      })
    ).run({ ...request, runId: "start-rejection" }, codexSafeProfileChatTerminalSchema)
    const receiptMismatch = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke: async (command: string) => {
          if (command === "codex_safe_profile_start") {
            return { runId: "admission-receipt-mismatch" }
          }
          throw new Error(`Unexpected command: ${command}`)
        },
        listen: async (_event, handler) => {
          handler({
            payload: {
              type: "admitted",
              runId: "admission-receipt-mismatch",
              provenance: { ...observedProvenance, provenanceFingerprint: "d".repeat(64) },
            },
          })
          return () => undefined
        },
      })
    ).run({ ...request, runId: "admission-receipt-mismatch" }, codexSafeProfileChatTerminalSchema)

    // Assert
    await expect(listenerFailure.admission).rejects.toThrow("listener failure")
    await expect(listenerFailure.completion).rejects.toThrow("listener failure")
    await expect(startFailure.admission).rejects.toThrow("start rejection")
    await expect(startFailure.completion).rejects.toThrow("start rejection")
    await expect(receiptMismatch.admission).rejects.toThrow("admission provenance does not match")
    await expect(receiptMismatch.completion).rejects.toThrow("admission provenance does not match")
  })

  it("admission_unavailable_public_failure_rejects_without_local_admission", async () => {
    // Arrange
    let eventHandler: ((event: { payload: unknown }) => void) | null = null
    const invoke = vi.fn(async (command: string) => {
      if (command === "codex_safe_profile_start") {
        eventHandler?.({
          payload: {
            type: "failed",
            runId: "admission-unavailable",
            code: "admission-unavailable",
            provenance: observedProvenance,
          },
        })
        return { runId: "admission-unavailable" }
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke,
        listen: async (_event, handler) => {
          eventHandler = handler
          return () => undefined
        },
      })
    )

    // Act
    const run = bridge.run(
      {
        runId: "admission-unavailable",
        prKey: "acme/web#42",
        operation: "review",
        prompt: "Bounded prompt",
        model: null,
        provenanceReceiptId: "test-receipt",
        observedProvenance,
      },
      codexSafeProfileReviewTerminalSchema
    )

    // Assert
    await expect(run.admission).rejects.toThrow("admission-unavailable")
    await expect(run.completion).rejects.toThrow("admission-unavailable")
    expect(invoke).toHaveBeenCalledOnce()
  })

  it("fixed_full_review_and_chat_schemas_reject_incomplete_unknown_and_mismatched_fixture_fields", async () => {
    // Arrange
    let eventHandler: ((event: { payload: unknown }) => void) | null = null
    const invoke = vi.fn(async (command: string) => {
      if (command !== "codex_safe_profile_start") throw new Error(`Unexpected command: ${command}`)
      eventHandler?.({
        payload: {
          type: "completed",
          runId: "fixed-schema-run",
          result: {
            summary: "Unknown usage must fail.",
            findings: [],
            requirementCoverage: null,
            reportedModel: null,
            usage: {},
          },
          usage: { elapsedMs: 42, toolEventCount: 0 },
        },
      })
      return { runId: "fixed-schema-run" }
    })
    const bridge = createCodexSafeProfileBridge(
      Promise.resolve({
        invoke,
        listen: async (_event, handler) => {
          eventHandler = handler
          return () => undefined
        },
      })
    )

    // Act
    const unknownReview = bridge.run(
      {
        runId: "fixed-schema-run",
        prKey: "acme/web#42",
        operation: "review",
        prompt: "App-owned fixed schema prompt",
        model: null,
        provenanceReceiptId: "test-receipt",
        observedProvenance,
      },
      codexSafeProfileReviewTerminalSchema
    )
    const incompleteChat = codexSafeProfileChatTerminalSchema.safeParse({
      message: "Missing candidate and provenance fields.",
    })
    const mismatchedReview = codexSafeProfileReviewTerminalSchema.safeParse({
      message: "A chat terminal cannot satisfy review output.",
      findingCandidate: null,
      reportedModel: null,
    })

    // Assert
    await expect(unknownReview.completion).rejects.toThrow()
    expect(incompleteChat.success).toBe(false)
    expect(mismatchedReview.success).toBe(false)
  })
})
