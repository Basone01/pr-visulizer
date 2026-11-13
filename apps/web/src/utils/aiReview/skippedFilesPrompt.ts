import type { OmissionReason, SkipReason } from "@pr-visulizer/shared"

import { escapeHiddenCharacters } from "@/utils/text/bidiControls"

// The review-file part of an agent's first prompt (CONTRACT §11.1, L8'). The agent reads the
// PR with its own git diff, so nothing else stops it from printing megabytes of build output:
// on a PR with generated CSS and source maps a whole-PR git diff printed about 12 MB.

export const MAX_NAMED_PROMPT_ENTRIES = 30
export const MAX_PROMPT_PATH_CHARS = 200
const MAX_EXAMPLE_EXCLUDES = 3

export type PromptChangedFile = {
  path: string
  skipReason: SkipReason | null
  diffOmitted: OmissionReason | null
}

export type ReviewFilesPromptInput = {
  // Every changed file of the PR, so a folder is named only when ALL its changed files are
  // generated.
  files: ReadonlyArray<PromptChangedFile>
  baseSha: string
  headSha: string
  // False while the analysis runs: only name-rule generated files are known then.
  analysisReady: boolean
}

export type ReviewFilesPrompt = {
  // Lines to add to the first prompt. Empty when no file is generated or diff-omitted.
  lines: string[]
  // The whole-PR sem command to recommend instead of sem diff --from/--to, which cannot leave
  // files out by path. Null when nothing must be left out.
  semDiffCommand: string | null
  // The filtered whole-PR git diff: the fallback when the piped sem command is refused or
  // fails. Null when nothing must be left out.
  gitDiffCommand: string | null
}

// No changed file to name, nothing to leave out.
export const NO_REVIEW_FILES: ReviewFilesPrompt = {
  lines: [],
  semDiffCommand: null,
  gitDiffCommand: null,
}

// One line of the generated list: a file, or a folder whose changed files are all generated.
type GeneratedEntry = {
  pathspec: string
  isFolder: boolean
  fileCount: number
}

const OMITTED_TEXT: Record<OmissionReason, string> = {
  "too-large": "diff too large to print whole",
  unreadable: "diff could not be read",
}

export function describeReviewFiles(input: ReviewFilesPromptInput): ReviewFilesPrompt {
  const range = `${input.baseSha}...${input.headSha}`
  const generatedEntries = generatedEntriesOf(input.files)
  const omittedFiles = input.files.filter(
    (file) => file.skipReason === null && file.diffOmitted !== null
  )
  const leftOutPathspecs = [
    ...generatedEntries.map((entry) => entry.pathspec),
    ...omittedFiles.map((file) => file.path),
  ]

  const generatedLines = describeGenerated(generatedEntries)
  const omittedLines = describeOmitted(omittedFiles, input.headSha)
  const excludes = exampleExcludes(leftOutPathspecs)
  const filteredDiff = `git diff ${range} -- . ${excludes.join(" ")}`
  const hasLeftOutFiles = leftOutPathspecs.length > 0

  const notKnownYet = input.analysisReady
    ? []
    : [
        "The analysis is still running, so files whose diff is too large are not known yet. list_pr_files lists every file with its skipReason and diffOmitted once it is done.",
      ]
  const howToLeaveOut = hasLeftOutFiles
    ? [
        `Leave these files out of every whole-PR git diff, git show and sem diff. Run git diff --stat ${range} first, then exclude them by path, for example: ${filteredDiff}`,
        `sem diff --from/--to cannot leave files out, so for sem's view pipe the filtered git diff into it: ${filteredDiff} | sem diff --patch -v. If that piped command is refused or fails, run the filtered git diff alone.`,
      ]
    : []

  return {
    lines: [...generatedLines, ...omittedLines, ...howToLeaveOut, ...notKnownYet],
    semDiffCommand: hasLeftOutFiles ? `${filteredDiff} | sem diff --patch -v` : null,
    gitDiffCommand: hasLeftOutFiles ? filteredDiff : null,
  }
}

function describeGenerated(entries: GeneratedEntry[]): string[] {
  if (entries.length === 0) return []

  const fileCount = entries.reduce((count, entry) => count + entry.fileCount, 0)
  const shown = entries.slice(0, MAX_NAMED_PROMPT_ENTRIES)
  const hiddenFileCount = entries
    .slice(MAX_NAMED_PROMPT_ENTRIES)
    .reduce((count, entry) => count + entry.fileCount, 0)

  return [
    `This PR changes ${fileCount} generated files (build output or vendored code). They need no reading. list_pr_files has the current list, each file with its skipReason:`,
    ...shown.map((entry) => `- ${generatedLineFor(entry)}`),
    ...(hiddenFileCount > 0 ? [`- and ${hiddenFileCount} more, see list_pr_files`] : []),
  ]
}

// A diff-omitted file is still part of the review: say how to read it in bounded pieces.
function describeOmitted(files: PromptChangedFile[], headSha: string): string[] {
  if (files.length === 0) return []

  const shown = files.slice(0, MAX_NAMED_PROMPT_ENTRIES)
  const hiddenCount = files.length - shown.length

  return [
    `These files are part of the review, but their diff cannot be printed whole. Read one in bounded pieces when it matters: git diff --stat for its size, then its own diff through a line window such as git diff <range> -- <path> | sed -n '1,200p', or git show ${headSha}:<path> | sed -n '1,200p'.`,
    ...shown.map((file) => `- ${promptPath(file.path).text}: ${OMITTED_TEXT[file.diffOmitted!]}`),
    ...(hiddenCount > 0 ? [`- and ${hiddenCount} more, see list_pr_files`] : []),
  ]
}

// The generated files as list entries, in path order. A folder replaces its files only when
// every changed file under it is generated, so the line stays exactly true. One pass counts
// each folder's changed and generated files, so this is files × depth, not files².
function generatedEntriesOf(files: ReadonlyArray<PromptChangedFile>): GeneratedEntry[] {
  const countsByFolder = new Map<string, { changed: number; generated: number }>()
  for (const file of files) {
    for (const folder of parentFolders(file.path)) {
      const counts = countsByFolder.get(folder) ?? { changed: 0, generated: 0 }
      counts.changed += 1
      if (file.skipReason === "generated") counts.generated += 1
      countsByFolder.set(folder, counts)
    }
  }

  const entries = new Map<string, GeneratedEntry>()
  for (const file of files) {
    if (file.skipReason !== "generated") continue

    // The shortest folder whose changed files are all generated. One file alone is named itself.
    const folder = parentFolders(file.path).find((candidate) => {
      const counts = countsByFolder.get(candidate)!
      return counts.changed === counts.generated && counts.changed > 1
    })
    const pathspec = folder ?? file.path
    const existing = entries.get(pathspec)
    if (existing) {
      existing.fileCount += 1
      continue
    }

    entries.set(pathspec, { pathspec, isFolder: folder !== undefined, fileCount: 1 })
  }

  return [...entries.values()].sort((a, b) => (a.pathspec < b.pathspec ? -1 : 1))
}

// "a/b/c.ts" -> ["a", "a/b"], shortest first.
function parentFolders(path: string): string[] {
  const segments = path.split("/").slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"))
}

function generatedLineFor(entry: GeneratedEntry): string {
  const shownPath = promptPath(entry.pathspec).text
  if (!entry.isFolder) return `${shownPath}: generated`

  return `every changed file under ${shownPath}/ (${entry.fileCount} files): generated`
}

// A path comes from the PR, so it is untrusted text going into a prompt. Hidden characters
// (controls, line separators, zero-width and bidi marks) are ESCAPED as \u{XXXX}, not dropped:
// the agent still sees which path it is, and two paths never collapse into one. Newlines and
// tabs, which the shared util keeps for ordinary text, are escaped here too, so a path stays
// on one line. The length is capped.
function promptPath(path: string): { text: string; wasChanged: boolean } {
  const escaped = escapeHiddenCharacters(path).text.replace(
    /[\n\t]/g,
    (character) => `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`
  )
  const text =
    escaped.length > MAX_PROMPT_PATH_CHARS ? `${escaped.slice(0, MAX_PROMPT_PATH_CHARS)}…` : escaped
  return { text, wasChanged: text !== path }
}

// Only a path that is exactly what git will match may enter the example command: no glob
// characters, no quote, no leading ":" or "-", nothing escaped or cut. Others stay in prose.
const UNSAFE_PATHSPEC = /[*?[\]'"\\]|^[:-]/

function exampleExcludes(pathspecs: string[]): string[] {
  const safe = pathspecs
    .filter((pathspec) => !UNSAFE_PATHSPEC.test(pathspec) && !promptPath(pathspec).wasChanged)
    .slice(0, MAX_EXAMPLE_EXCLUDES)
    .map((pathspec) => `':(exclude)${pathspec}'`)

  return safe.length > 0 ? safe : ["':(exclude)<path>'"]
}
