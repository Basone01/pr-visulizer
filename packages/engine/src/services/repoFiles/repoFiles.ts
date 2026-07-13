import { mapWithConcurrency } from "../../utils/concurrency.js"
import { languageForPath } from "../../utils/language.js"
import { basename } from "../../utils/posixPath.js"

// The repo-checkout seam for deep-engine v1 (docs/architecture.md §6). The desktop app
// provides it from a full `git clone` at `headSha`; tests provide an in-memory map. The
// engine asserts NOTHING about git here — it only lists and reads paths, so the seam is
// platform-neutral (no node builtins) and swappable in one place, exactly like the
// GithubGateway. Paths are POSIX repo paths (forward slashes), as everywhere else.
export type RepoFiles = {
  listFiles(): Promise<string[]>
  readFile(path: string): Promise<string>
}

// Controllable core (architecture style): every knob a deep scan legitimately needs is a
// setting with a sane default. `maxFileBytes` caps parse cost; the ignore lists keep
// vendored and generated code out of the index. Callers override individual fields.
export type RepoScanSettings = {
  // Skip a source file larger than this many UTF-8 bytes (default ~1.5 MB). RepoFiles
  // has no `stat`, so the cap is enforced AFTER read but BEFORE the expensive parse.
  maxFileBytes: number
  // Skip any path with one of these as a path SEGMENT (`vendor/`, `node_modules/`, `.git/`).
  ignoreDirs: string[]
  // Skip any path ending with one of these (generated protobuf `*.pb.go`).
  ignoreSuffixes: string[]
  // Bounded concurrency for the checkout reads (default 6). The desktop's RepoFiles.readFile
  // is a real IO round-trip (a Rust `invoke`), so a fixed pool hides its latency across a
  // thousand-file repo without spawning a read per file at once.
  readConcurrency: number
}

export const DEFAULT_REPO_SCAN: RepoScanSettings = {
  maxFileBytes: 1_500_000,
  ignoreDirs: ["vendor", "node_modules", ".git"],
  ignoreSuffixes: [".pb.go"],
  readConcurrency: 6,
}

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).length

// Whether a read content passes the size cap — exported so a platform that batch-reads the
// checkout itself (the desktop's Rust git reads) applies the exact same gate before parsing.
export function withinSizeCap(content: string, settings: RepoScanSettings): boolean {
  return utf8ByteLength(content) <= settings.maxFileBytes
}

function isIgnored(path: string, settings: RepoScanSettings): boolean {
  const segments = path.split("/")
  if (segments.some((segment) => settings.ignoreDirs.includes(segment))) return true

  return settings.ignoreSuffixes.some((suffix) => path.endsWith(suffix))
}

// A file worth reading for deep analysis: a source file we have a grammar for, a `go.mod`
// (its module path drives Go import resolution, §6), or a `tsconfig.json` (its `paths` drive
// TS alias resolution — same precedent). Everything else — binaries, docs, lockfiles — is
// never read, so a huge unreadable asset never costs anything.
const CONFIG_BASENAMES = ["go.mod", "tsconfig.json"]

function isReadCandidate(path: string): boolean {
  return languageForPath(path) !== null || CONFIG_BASENAMES.includes(basename(path))
}

// The read-worthy subset of a checkout's path list (ignore dirs/suffixes applied, non-source
// files dropped). Exported for the same reason as `withinSizeCap`: the desktop lists paths via
// git and batch-reads them in Rust, and must select exactly the files this reader would.
export function scanCandidatePaths(paths: string[], settings: RepoScanSettings): string[] {
  return paths.filter((path) => !isIgnored(path, settings) && isReadCandidate(path))
}

export type RepoScanResult = {
  contents: Map<string, string> // path → head content, for candidates that passed every gate
  skipped: { ignored: number; oversized: number; unreadable: number }
}

// Read the deep-analysis inputs from the checkout, DEFENSIVELY: an unreadable file
// (permissions, a broken symlink, vanished mid-scan) or one over the size cap is skipped,
// never fatal — one bad file must not sink the whole analysis. Reads run with bounded
// concurrency; `onRead` reports the running done/total over the read-candidate set (the
// meaningful "reading files" total). Returns the content map plus skip counts.
export async function readRepoSources(
  repoFiles: RepoFiles,
  settings: RepoScanSettings,
  onRead?: (done: number, total: number) => void
): Promise<RepoScanResult> {
  const paths = await repoFiles.listFiles()
  const contents = new Map<string, string>()
  const skipped = { ignored: 0, oversized: 0, unreadable: 0 }

  // Partition first: ignored paths never cost a read; non-candidates (binaries, docs) are
  // silently skipped; only the candidates are read (with bounded concurrency below).
  const candidates: string[] = []
  for (const path of paths) {
    if (isIgnored(path, settings)) {
      skipped.ignored += 1
      continue
    }

    if (!isReadCandidate(path)) continue

    candidates.push(path)
  }

  // A null content marks an unreadable file — the defensive skip is a value, not a throw,
  // so one bad file never rejects the whole pool.
  const reads = await mapWithConcurrency(
    candidates,
    settings.readConcurrency,
    async (path): Promise<{ path: string; content: string | null }> => {
      try {
        return { path, content: await repoFiles.readFile(path) }
      } catch {
        return { path, content: null }
      }
    },
    onRead ? (done) => onRead(done, candidates.length) : undefined
  )

  for (const { path, content } of reads) {
    if (content === null) {
      skipped.unreadable += 1
      continue
    }

    if (!withinSizeCap(content, settings)) {
      skipped.oversized += 1
      continue
    }

    contents.set(path, content)
  }

  return { contents, skipped }
}
