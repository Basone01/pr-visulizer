import { parseUnifiedDiff } from "@/utils/diff/parseUnifiedDiff"

import { pr42Patches } from "./patches"
import { pr42Analysis } from "./pr42"

// Head-revision file contents for PR #42 (docs/architecture.md §7) — the full-file diff view's
// input in fixture mode (§10), standing in for the BFF files endpoint's `content`.
//
// An ADDED file needs no entry here: its patch IS the whole file, so it is reconstructed from
// the additions. A MODIFIED file cannot be reconstructed — a patch only carries its hunks — so
// its head text is spelled out below, deliberately with unchanged lines above and below the
// hunk. Those unchanged lines are the whole point of the full-file view.

const modifiedHeadFiles: Record<string, string> = {
  // Hunk covers head lines 3–5 (@@ -3,2 +3,3 @@); lines 1–2 (the ApiError signature) and
  // everything from line 6 down are unchanged, so they live ONLY here.
  "src/types/http.ts": [
    "export type ApiError = {",
    "  code: string",
    "  message: string",
    "  retryAfterSeconds?: number",
    "}",
    "",
    "export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }",
    "",
    "export function isApiError(value: unknown): value is ApiError {",
    '  return typeof value === "object" && value !== null && "code" in value',
    "}",
  ].join("\n"),

  // Hunk covers head lines 1–8 (@@ -1,4 +1,8 @@); the logout handler below it never changed.
  "src/api/routes/login.ts": [
    "import { authenticate } from '../../auth'",
    "import { withRateLimit } from '../../middleware/withRateLimit'",
    "",
    "export const loginHandler = withRateLimit(async (req, res) => {",
    "  const user = await authenticate(req, res)",
    "  if (!user) return res.status(401).end()",
    "  return res.json({ user })",
    "})",
    "",
    "export const logoutHandler = async (req, res) => res.status(204).end()",
  ].join("\n"),
}

function reconstructAddedFile(patch: string): string {
  return parseUnifiedDiff(patch)
    .lines.filter((line) => line.kind === "add")
    .map((line) => line.content)
    .join("\n")
}

// null = no head content for this path in the fixture — the same "unavailable" answer a real
// client gives for a deleted or binary file, so the disabled-toggle path stays exercisable.
export function pr42HeadFile(path: string): string | null {
  const explicit = modifiedHeadFiles[path]
  if (explicit !== undefined) return explicit

  const patch = pr42Patches[path]
  const status = pr42Analysis.files.find((file) => file.path === path)?.status
  if (patch === undefined || status !== "added") return null

  return reconstructAddedFile(patch)
}
