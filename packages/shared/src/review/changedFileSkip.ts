import type { FileOmission, SkippedFile } from "../entities/analysis.js"

// Which changed files are generated, and which have a part that cannot be read (CONTRACT
// §11.1). Analysis, the queue, the diff pane and the agent prompt all decide through
// classifyChangedFile, so one file never gets two answers.

// The AI repository-context policy's folder lists. That policy matches them on any segment,
// which is right for keeping a folder's files out of AI context and too loose for a review:
// the review rule below uses them on folder segments only, and only with machine-made shape.
export const DEPENDENCY_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "bower_components",
  "node_modules",
  "vendor",
])
export const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".generated",
  "__generated__",
  "build",
  "dist",
  "generated",
])
export const GENERATED_FILE_SUFFIXES: readonly string[] = [".map", ".min.js", ".min.css", ".pb.go"]

// A folder no hand-written file of the PR lives in. Matching it alone is enough evidence.
const DEPENDENCY_ONLY_DIRECTORY = "node_modules"
// Folders that hold build output, but often hand-written code too (cmd/build, a PHP Vendor
// domain). Matching one is evidence only together with machine-made shape.
const BUILD_LIKE_DIRECTORIES: ReadonlySet<string> = new Set([
  ...GENERATED_DIRECTORIES,
  "bower_components",
  "vendor",
])

// No editor writes a line this long. Minified CSS, bundles and source maps do.
export const LONG_GENERATED_LINE_CHARS = 5_000

// The desktop's native `repo_file_diff` cap (apps/desktop/src-tauri/src/lib.rs,
// MAX_REPO_FILE_DIFF_BYTES). A test reads the Rust source, so the two cannot drift apart.
export const NATIVE_PATCH_BYTE_LIMIT = 128 * 1024

// What a reader learned about a file's patch.
export type PatchEvidence =
  | { kind: "patch"; patch: string }
  | { kind: "over-cap" } // the native reader refused it on bytes
  | { kind: "omitted-by-github" } // the API has no patch for it
  | { kind: "unreadable"; message: string } // any other per-file failure
  | { kind: "not-read" } // the path alone decided

export type ChangedFileFacts = {
  skip: SkippedFile | null
  diffOmission: FileOmission | null
}

// True when the NAME alone proves the file is generated: an unambiguous generated suffix, or a
// node_modules folder. Such a file needs no patch read to be classified.
export function isGeneratedByName(path: string): boolean {
  const segments = path.split("/")
  const fileName = segments.at(-1) ?? ""
  const folders = segments.slice(0, -1)

  const hasGeneratedSuffix = GENERATED_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))
  const inNodeModules = folders.includes(DEPENDENCY_ONLY_DIRECTORY)
  return hasGeneratedSuffix || inNodeModules
}

// A folder segment (never the file name, case-sensitive) names build output or vendored code.
export function isInBuildLikeDirectory(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((folder) => BUILD_LIKE_DIRECTORIES.has(folder))
}

// The two facts for one changed file, from its path and what its patch reader learned.
export function classifyChangedFile(path: string, evidence: PatchEvidence): ChangedFileFacts {
  const isGenerated =
    isGeneratedByName(path) || (isInBuildLikeDirectory(path) && hasMachineMadeShape(evidence))
  if (isGenerated) return { skip: { path, reason: "generated" }, diffOmission: null }

  return { skip: null, diffOmission: diffOmissionFor(path, evidence) }
}

function hasMachineMadeShape(evidence: PatchEvidence): boolean {
  if (evidence.kind === "over-cap" || evidence.kind === "omitted-by-github") return true
  if (evidence.kind !== "patch") return false

  return longestLineLength(evidence.patch) > LONG_GENERATED_LINE_CHARS
}

// The diff part's omission alone, whatever the file is: a generated file shown anyway still has
// its diff refused when it is over the cap.
export function diffOmissionFor(path: string, evidence: PatchEvidence): FileOmission | null {
  if (evidence.kind === "over-cap") {
    return { path, part: "diff", reason: "too-large", limitBytes: NATIVE_PATCH_BYTE_LIMIT }
  }
  if (evidence.kind === "omitted-by-github") return { path, part: "diff", reason: "too-large" }
  if (evidence.kind === "unreadable") {
    return { path, part: "diff", reason: "unreadable", message: evidence.message }
  }

  return null
}

// Walks the patch once by newline positions, so a one-line 128 KiB patch is not split.
function longestLineLength(patch: string): number {
  let longest = 0
  let lineStart = 0

  while (lineStart <= patch.length) {
    const newline = patch.indexOf("\n", lineStart)
    const lineEnd = newline === -1 ? patch.length : newline
    longest = Math.max(longest, lineEnd - lineStart)
    if (newline === -1) break

    lineStart = newline + 1
  }

  return longest
}

// The facts an engine reports for a PR's changed files: what its reader already decided, or,
// for a reader that decided nothing, the name rule.
export function changedFileFactsOf(
  files: ReadonlyArray<{ path: string; skip?: SkippedFile; omissions?: FileOmission[] }>
): { skipped: SkippedFile[]; omitted: FileOmission[] } {
  const skipped = files.flatMap((file) => {
    const skip = file.skip ?? classifyChangedFile(file.path, { kind: "not-read" }).skip
    return skip ? [skip] : []
  })
  const omitted = files.flatMap((file) => file.omissions ?? [])

  return { skipped, omitted }
}
