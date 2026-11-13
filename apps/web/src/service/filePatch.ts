import {
  type ChangedFileFacts,
  type FilePatch,
  type PatchEvidence,
  type RangeDiffFile,
  classifyChangedFile,
  diffOmissionFor,
} from "@pr-visulizer/shared"

import type { PrTarget } from "@/entity/pr"

import { NoPatchAvailableError, type PrClient, isPatchByteLimitRefusal } from "./prClient"

// One file's patch read, as evidence for classifyChangedFile. The analysis and the diff pane
// both read through here, so a refusal means the same thing to both. A refusal on bytes and
// a missing API patch are facts about the file. Any other failure of a per-file read (a Tauri
// command rejects with a bare string, such as "git diff was not valid UTF-8") is too.
export async function readPatchEvidence(read: () => Promise<string>): Promise<PatchEvidence> {
  try {
    return { kind: "patch", patch: await read() }
  } catch (error) {
    if (isPatchByteLimitRefusal(error)) return { kind: "over-cap" }
    if (error instanceof NoPatchAvailableError) return { kind: "omitted-by-github" }
    if (typeof error === "string") return { kind: "unreadable", message: error }

    throw error
  }
}

// What the analysis already decided for this file, when it has run.
export type KnownFileFacts = ChangedFileFacts | null

export type GeneratedPatchPolicy = "skip" | "show"

export type FilePatchRequest = {
  target: PrTarget
  path: string
  // "show" is the pane's "Show diff anyway": read a generated file's patch too. A patch over
  // the cap is still refused by the reader.
  generated: GeneratedPatchPolicy
  known: KnownFileFacts
}

type PatchDecision = Pick<FilePatchRequest, "path" | "generated" | "known">

// One file's patch for the diff pane, as a result, never an endless load. When the analysis
// or the name alone already decides, nothing is read.
export async function readFilePatch(
  client: PrClient,
  request: FilePatchRequest
): Promise<FilePatch> {
  const decidedWithoutReading = filePatchFor(request, { kind: "not-read" })
  if (decidedWithoutReading) return decidedWithoutReading

  const evidence = await readPatchEvidence(() => client.getPatch(request.target, request.path))
  return filePatchFor(request, evidence) ?? { kind: "patch", patch: "" }
}

// A commit range's own patch for one file, decided the same way. GitHub's compare API gives a
// null patch both for a diff it omits and for a pure rename with no change in it.
export function rangeFilePatch(
  request: PatchDecision,
  rangeFile: Pick<RangeDiffFile, "patch" | "additions" | "deletions">
): FilePatch {
  const hasChanges = rangeFile.additions + rangeFile.deletions > 0
  const evidence: PatchEvidence =
    rangeFile.patch !== null
      ? { kind: "patch", patch: rangeFile.patch }
      : hasChanges
        ? { kind: "omitted-by-github" }
        : { kind: "patch", patch: "" }
  return filePatchFor(request, evidence) ?? { kind: "patch", patch: rangeFile.patch ?? "" }
}

// The one decision: the analysis's facts when it has them, the shared classifier when it has
// not. Null when the evidence is "not-read" and reading is needed to decide.
function filePatchFor(request: PatchDecision, evidence: PatchEvidence): FilePatch | null {
  const { path, known } = request
  const showGenerated = request.generated === "show"

  const skip = known ? known.skip : classifyChangedFile(path, evidence).skip
  if (skip && !showGenerated) return { kind: "generated", skip }

  const omission = known?.diffOmission ?? diffOmissionFor(path, evidence)
  if (omission) return { kind: "omitted", omission }
  if (evidence.kind === "patch") return { kind: "patch", patch: evidence.patch }

  return null
}
