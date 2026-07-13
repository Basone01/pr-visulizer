import { languageForPath } from "@pr-visulizer/engine"
import type { ChangedFile } from "@pr-visulizer/shared"

import type { PrTarget } from "@/entity/pr"
import type { RepoLink } from "@/entity/repoSource"

import { type CloneManager, type CloneProgress, fetchArgs, parseGitProgress } from "./cloneManager"
import { findRepoLink } from "./repoLinks"

// The repo-source seam (docs/tauri-architecture.md §6, deep-only desktop): where deep
// analysis reads the repo from. `prepare` lands the PR head in a local git object DB and
// returns readers pinned AT THAT SHA — never a working tree, so a linked repo's checkout,
// branches and index are provably untouched (the only mutation is `git fetch`, which writes
// objects + FETCH_HEAD). Two implementations: the user's own linked clone (preferred) and
// the managed clone dir (fallback, wraps the existing clone manager).

export type PreparedRepoSource = {
  // Whether the base commit is present locally (its object fetch succeeded). The changed-file
  // list and per-file diffs both need `base...head`, so when this is false the caller falls
  // back to the GitHub API for THIS PR's file list + patches (docs/tauri-architecture.md §6).
  baseReady: boolean
  // Repo-relative POSIX paths in the tree at the pinned head SHA.
  listFiles(): Promise<string[]>
  // One file's content at the pinned head SHA (readMany of one — kept for seam completeness).
  readFile(path: string): Promise<string>
  // Batch-read many files at the pinned head SHA. Missing paths and binary (non-UTF-8) blobs
  // are simply absent from the returned map — the caller treats both as "skip", mirroring the
  // engine's defensive reader. `onChunk` reports running done/total over the request set.
  readMany(
    paths: string[],
    onChunk?: (done: number, total: number) => void
  ): Promise<Map<string, string>>
  // The PR's changed files (status + churn), computed locally over `base...head` — the same
  // set GitHub's listFiles returns, without its patch payloads. Requires `baseReady`.
  listChangedFiles(): Promise<ChangedFile[]>
  // One file's unified-diff patch over `base...head`, computed locally (the lazy diff view and
  // the analysis's per-file changed-symbol hunks). Requires `baseReady`.
  readFileDiff(path: string): Promise<string>
}

export type RepoSource = {
  kind: "linked" | "managed"
  prepare(
    target: PrTarget,
    baseSha: string,
    headSha: string,
    onProgress?: CloneProgress
  ): Promise<PreparedRepoSource>
}

// ~400 paths per invoke bounds the IPC payload (a chunk's contents can reach tens of MB on
// generated files) while still amortizing the one-git-child-per-call cost.
const READ_CHUNK_SIZE = 400

async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}

// What the Rust `repo_changed_files` command returns per file — status + churn, no language
// (the JS side tags language) and no patch (fetched lazily per file via repo_file_diff).
type RawChangedFile = {
  path: string
  status: string
  additions: number
  deletions: number
}

// Readers over a git dir's OBJECT DB — content reads pin at `headRev`; the changed-file list
// and per-file patches diff `base...head`. The Rust commands spawn `ls-tree`/`cat-file
// --batch`/`diff` and parse the output (lib.rs). Shared by both sources: a linked repo and a
// managed clone read identically once the objects are local. Exported for a fake-invoke test.
export function createGitRevReader(
  root: string,
  baseRev: string,
  headRev: string,
  baseReady: boolean
): PreparedRepoSource {
  async function readChunk(paths: string[]): Promise<Array<[string, string | null]>> {
    return invokeCommand<Array<[string, string | null]>>("repo_read_many_at_rev", {
      root,
      rev: headRev,
      paths,
    })
  }

  return {
    baseReady,

    async listFiles(): Promise<string[]> {
      return invokeCommand<string[]>("repo_list_at_rev", { root, rev: headRev })
    },

    async readFile(path: string): Promise<string> {
      const chunk = await readChunk([path])
      const content = chunk[0]?.[1]
      if (content === null || content === undefined) {
        throw new Error(`no readable file at ${headRev}:${path}`)
      }

      return content
    },

    async readMany(paths, onChunk): Promise<Map<string, string>> {
      const contents = new Map<string, string>()

      for (let start = 0; start < paths.length; start += READ_CHUNK_SIZE) {
        const chunk = await readChunk(paths.slice(start, start + READ_CHUNK_SIZE))
        for (const [path, content] of chunk) {
          if (content !== null) contents.set(path, content)
        }

        onChunk?.(Math.min(start + READ_CHUNK_SIZE, paths.length), paths.length)
      }

      return contents
    },

    async listChangedFiles(): Promise<ChangedFile[]> {
      const raw = await invokeCommand<RawChangedFile[]>("repo_changed_files", {
        root,
        baseRev,
        headRev,
      })

      // The Rust command emits only the four contract statuses (proven by its cargo test), so
      // the cast is safe; language is the same path→grammar map the Octokit gateway applies.
      return raw.map((file) => ({
        path: file.path,
        status: file.status as ChangedFile["status"],
        additions: file.additions,
        deletions: file.deletions,
        language: languageForPath(file.path),
      }))
    },

    async readFileDiff(path: string): Promise<string> {
      return invokeCommand<string>("repo_file_diff", { root, baseRev, headRev, path })
    },
  }
}

// Fetch the PR head into a git dir's object DB — `git fetch origin pull/<n>/head`, the same
// scoped shell command the clone manager uses. NO checkout follows here: for a linked repo
// the user's worktree must stay untouched; reads then pin to the head SHA directly (not
// FETCH_HEAD, which any later fetch would overwrite).
async function fetchPrHead(
  dir: string,
  prNumber: number,
  onProgress?: CloneProgress
): Promise<void> {
  const { Command } = await import("@tauri-apps/plugin-shell")
  const command = Command.create("git-fetch-pull", fetchArgs(dir, prNumber))

  const stderrLines: string[] = []
  command.stderr.on("data", (line: string) => {
    stderrLines.push(line)
    const detail = parseGitProgress(line)
    if (detail) onProgress?.("fetching", detail)
  })

  await new Promise<void>((resolve, reject) => {
    command.on("close", (payload: { code: number | null }) => {
      if (payload.code === 0) resolve()
      else reject(new Error(stderrLines.join("\n").trim() || `git fetch exited ${payload.code}`))
    })
    command.on("error", (error: string) => reject(new Error(error)))
    void command.spawn().catch(reject)
  })
}

// Ensure the PR's BASE commit is present locally so `base...head` diffs resolve. The linked
// clone usually has the base branch, but the exact baseSha may not be fetched yet — this
// fetches just that object (a fast no-op if already present). Best-effort: a failure (e.g. a
// server that won't serve an unadvertised SHA) returns false and the caller falls back to the
// API for that PR's patches, so the review never hard-fails (docs/tauri-architecture.md §6).
async function ensureBaseObject(dir: string, baseSha: string): Promise<boolean> {
  try {
    const { Command } = await import("@tauri-apps/plugin-shell")
    const output = await Command.create("git-fetch-object", [
      "-C",
      dir,
      "fetch",
      "origin",
      baseSha,
    ]).execute()

    return output.code === 0
  } catch {
    return false
  }
}

// The preferred source: the user's EXISTING local clone. Fetch the PR head into its object DB
// (no checkout — the worktree is theirs, not ours), ensure the base object is present, then
// read/diff at those SHAs.
export function createLinkedRepoSource(link: RepoLink): RepoSource {
  return {
    kind: "linked",

    async prepare(target, baseSha, headSha, onProgress): Promise<PreparedRepoSource> {
      onProgress?.("fetching")
      await fetchPrHead(link.path, target.number, onProgress)
      const baseReady = await ensureBaseObject(link.path, baseSha)

      return createGitRevReader(link.path, baseSha, headSha, baseReady)
    },
  }
}

// The fallback source: the managed clone dir (docs/tauri-architecture.md §6). The clone
// manager clones/fetches/checks out as before (its dir is OUR cache, so the checkout is
// fine); reads still go through the object DB at the head SHA for the same batch speed.
export function createManagedRepoSource(cloneManager: CloneManager, cloneRoot: string): RepoSource {
  return {
    kind: "managed",

    async prepare(target, baseSha, headSha, onProgress): Promise<PreparedRepoSource> {
      const { dir } = await cloneManager.prepare(cloneRoot, target, onProgress)
      const baseReady = await ensureBaseObject(dir, baseSha)

      return createGitRevReader(dir, baseSha, headSha, baseReady)
    },
  }
}

// Which source a PR should read from — pure decision, so the selection is testable without
// Tauri: the linked repo when one is registered for the PR's owner/repo, else the managed
// clone when a clone root is set, else nothing (the caller surfaces the locate-vs-clone
// prompt via NeedsRepoSourceError).
export type RepoSourceChoice =
  { kind: "linked"; link: RepoLink } | { kind: "managed"; cloneRoot: string } | { kind: "none" }

export function chooseRepoSource(
  links: RepoLink[],
  cloneRoot: string | null,
  target: PrTarget
): RepoSourceChoice {
  const link = findRepoLink(links, target)
  if (link) return { kind: "linked", link }

  if (cloneRoot) return { kind: "managed", cloneRoot }

  return { kind: "none" }
}
