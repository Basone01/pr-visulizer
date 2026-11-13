import type { DraftComment, OmissionReason, QueueMode, SkipReason } from "@pr-visulizer/shared"

import type { TrayRow } from "@/entity/viewModels"

// The reviewer's state as the terminal agent sees it (.task/agent-protocol-v2/STATE.md).
// Field names are the wire contract with the desktop side, so rename them only together.

export type LineRange = {
  startLine: number
  endLine: number
}

export type ReviewSelection = LineRange & {
  path: string
}

export type ReviewFile = {
  path: string
  status: TrayRow["status"]
  reviewed: boolean
  suggestedNext: boolean
  // "generated" for build output or vendored code, which the agent need not read, or null.
  skipReason: SkipReason | null
  // Why the file's diff cannot be printed whole, or null. The file still needs review: the
  // agent reads it in bounded pieces.
  diffOmitted: OmissionReason | null
}

export type ReviewDraft = LineRange & {
  path: string
  // RIGHT lines are head line numbers, LEFT lines (a comment on a deleted line) are base ones.
  side: DraftComment["side"]
  body: string
}

export type ReviewSnapshot = {
  queueMode: QueueMode
  selection: ReviewSelection | null
  files: ReviewFile[]
  drafts: ReviewDraft[]
}

export type ReviewSnapshotInput = {
  // The rows the review tray shows, already in the chosen queue order.
  trayRows: ReadonlyArray<
    Pick<TrayRow, "path" | "status" | "reviewed" | "skipReason" | "diffOmitted">
  >
  drafts: ReadonlyArray<DraftComment>
  nextFilePath: string | null
  queueMode: QueueMode
  openFilePath: string | null
  selection: ReviewSelection | null
}

export function buildReviewSnapshot(input: ReviewSnapshotInput): ReviewSnapshot {
  const files = input.trayRows.map((row) => ({
    path: row.path,
    status: row.status,
    reviewed: row.reviewed,
    suggestedNext: row.path === input.nextFilePath,
    skipReason: row.skipReason,
    diffOmitted: row.diffOmitted,
  }))
  const drafts = input.drafts.map((draft) => ({
    path: draft.path,
    side: draft.side,
    startLine: draft.startLine ?? draft.line,
    endLine: draft.line,
    body: draft.body,
  }))
  const isSelectionInOpenFile = input.selection?.path === input.openFilePath

  return {
    queueMode: input.queueMode,
    selection: isSelectionInOpenFile ? input.selection : null,
    files,
    drafts,
  }
}
