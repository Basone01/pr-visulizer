import { type AnswerReport, answerReportSchema } from "@pr-visulizer/shared"
import { z } from "zod"

const answerReportPayloadSchema = z.record(z.string(), z.unknown())

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
  return tauriInvoke<T>(command, args)
}

export async function loadAnswerReport(sessionId: string): Promise<AnswerReport | null> {
  const state = await invoke<unknown>("codex_answer_window_state", { request: { sessionId } })
  if (state === null) return null

  return answerReportSchema.parse(answerReportPayloadSchema.parse(state))
}

export async function openAnswerFile(
  sessionId: string,
  path: string,
  line?: number
): Promise<void> {
  await invoke("codex_answer_window_open_file", { request: { sessionId, path, line } })
}

// Rejects when the agent has not rendered an answer for this session yet.
export async function showAnswerWindow(sessionId: string): Promise<void> {
  await invoke("codex_answer_window_show", { request: { sessionId } })
}

export async function subscribeAnswerReports(
  sessionId: string,
  onReport: (report: AnswerReport) => void
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event")
  return listen("codex-answer://updated", (event: { payload: unknown }) => {
    const payload = answerReportPayloadSchema.safeParse(event.payload)
    if (!payload.success) return

    const parsed = answerReportSchema.safeParse(payload.data)
    if (parsed.success && parsed.data.sessionId === sessionId) onReport(parsed.data)
  })
}
