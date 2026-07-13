import type { RepoFiles } from "@pr-visulizer/engine"

import type { PrTarget } from "@/entity/pr"

// The clone manager (docs/tauri-architecture.md §6 deep mode): turn a PR target into a local
// git checkout at the PR head, then expose it as the engine's RepoFiles seam. It is the narrow
// wrapper over the Tauri Shell + Filesystem plugins — call sites depend on `CloneManager`,
// never on `Command`/`readTextFile`, so the mechanism is swappable in one place and a test can
// inject a fake that returns an in-memory checkout (external-lib rule).
//
// Layout: `<cloneRoot>/<owner>/<repo>` — one worktree per repo, reused across the repo's PRs.
// Fresh: `gh repo clone <owner>/<repo> <dir>` (gh carries private-repo auth), then fetch +
// check out the PR head. Reuse: skip the clone, just fetch + check out. Both land on the PR
// head via `fetch origin pull/<n>/head` → `checkout --detach FETCH_HEAD`.

export type ClonePhase = "cloning" | "fetching" | "checking-out"

export type CloneProgress = (phase: ClonePhase, detail?: string) => void

export type PreparedCheckout = {
  dir: string
  repoFiles: RepoFiles
}

export type CloneManager = {
  prepare(
    cloneRoot: string,
    target: PrTarget,
    onProgress?: CloneProgress
  ): Promise<PreparedCheckout>
}

// ── pure arg building (tested without Tauri) ────────────────────────────────
// These build the exact argv each command runs with. Kept pure so the fresh-vs-reuse shapes
// and the path layout are verifiable directly, and so the capability validators (§7) have one
// obvious source of truth for what args the shell scope must accept.

// `<owner>/<repo>` — the slug `gh repo clone` takes.
export function ownerRepoSlug(target: PrTarget): string {
  return `${target.owner}/${target.repo}`
}

// `<cloneRoot>/<owner>/<repo>`, POSIX. A trailing slash on the picked root is normalized so
// the layout is stable regardless of how the folder path came back from the dialog.
export function checkoutDir(cloneRoot: string, target: PrTarget): string {
  const root = cloneRoot.replace(/\/+$/, "")
  return `${root}/${target.owner}/${target.repo}`
}

export function cloneArgs(target: PrTarget, dir: string): string[] {
  // `-- --progress` forces git's progress lines even without a TTY — they feed the
  // live "Receiving objects: 42%" detail on the deepen button.
  return ["repo", "clone", ownerRepoSlug(target), dir, "--", "--progress"]
}

export function fetchArgs(dir: string, prNumber: number): string[] {
  return ["-C", dir, "fetch", "--progress", "origin", `pull/${prNumber}/head`]
}

// `--force` overwrites any local changes: this is OUR cache dir, so a dirty worktree from a
// prior checkout is discarded rather than blocking (documented trade-off, §6). `--detach`
// lands on the PR head commit with no local branch to drift.
export function checkoutArgs(dir: string): string[] {
  return ["-C", dir, "checkout", "--force", "--detach", "FETCH_HEAD"]
}

export function lsFilesArgs(dir: string): string[] {
  return ["-C", dir, "ls-files"]
}

// Join the checkout dir with a repo-relative POSIX path for an fs read.
export function checkoutFilePath(dir: string, repoPath: string): string {
  return `${dir}/${repoPath}`
}

// ── Tauri-backed implementation (lazy plugin imports) ───────────────────────
// The Shell/Filesystem plugins load through literal dynamic imports so they stay in their own
// chunks, out of the web/http entry bundle (same pattern as ghToken/tauriHttp).

type ShellOutput = { code: number | null; stdout: string; stderr: string }

// Extract a human progress snippet from git's stderr ("Receiving objects:  42% (…)").
// Exported for tests. Returns null for non-progress lines.
export function parseGitProgress(line: string): string | null {
  const match =
    /(Counting objects|Compressing objects|Receiving objects|Resolving deltas):\s+(\d+)%/.exec(line)
  return match ? `${match[1]} ${match[2]}%` : null
}

// Run one scoped command; a non-zero exit surfaces its stderr so the UI can show the real
// cause (auth, network, missing gh). A rejected spawn (missing binary / scope denial) also
// propagates as a rejection — both reach the deepen error surface.
async function runScoped(name: string, args: string[]): Promise<ShellOutput> {
  const { Command } = await import("@tauri-apps/plugin-shell")
  const output = await Command.create(name, args).execute()

  if (output.code !== 0) {
    throw new Error(output.stderr.trim() || `command "${name}" exited ${output.code}`)
  }

  return output
}

// Like runScoped, but spawned with stderr streamed line by line — the long-running
// clone/fetch report progress there, and the button shows it live instead of a
// minutes-long static label that reads as stuck.
async function runScopedStreaming(
  name: string,
  args: string[],
  onStderrLine: (line: string) => void
): Promise<void> {
  const { Command } = await import("@tauri-apps/plugin-shell")
  const command = Command.create(name, args)

  const stderrLines: string[] = []
  command.stderr.on("data", (line: string) => {
    stderrLines.push(line)
    onStderrLine(line)
  })

  await new Promise<void>((resolve, reject) => {
    command.on("close", (payload: { code: number | null }) => {
      if (payload.code === 0) resolve()
      else
        reject(
          new Error(stderrLines.join("\n").trim() || `command "${name}" exited ${payload.code}`)
        )
    })
    command.on("error", (error: string) => reject(new Error(error)))
    void command.spawn().catch(reject)
  })
}

type CheckoutState = "fresh" | "reuse" | "not-a-repo"

// Checkout probes + reads go through the app's own Rust commands (lib.rs), NOT the fs
// plugin: the dialog-granted fs scope proved unreliable for subpaths and refuses hidden
// paths outright — `exists(<dir>/.git)` is denied no matter what the user grants. The
// Rust commands do their own canonicalized containment check instead of scope matching.
async function repoPathExists(root: string, relative: string): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<boolean>("repo_path_exists", { root, relative })
}

async function checkoutState(dir: string): Promise<CheckoutState> {
  if (!(await repoPathExists(dir, "."))) return "fresh"
  if (!(await repoPathExists(dir, ".git"))) return "not-a-repo"

  return "reuse"
}

// Repo listing via `git ls-files` (respects .gitignore, one process); reads via the
// validated Rust command (see note above).
function checkoutRepoFiles(dir: string): RepoFiles {
  return {
    async listFiles(): Promise<string[]> {
      const { stdout } = await runScoped("git-ls-files", lsFilesArgs(dir))
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    },

    async readFile(path: string): Promise<string> {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<string>("repo_read_text", { root: dir, relative: path })
    },
  }
}

export function createTauriCloneManager(): CloneManager {
  return {
    async prepare(cloneRoot, target, onProgress): Promise<PreparedCheckout> {
      const dir = checkoutDir(cloneRoot, target)
      const state = await checkoutState(dir)

      if (state === "not-a-repo") {
        throw new Error(
          `${dir} exists but is not a git checkout — remove it or pick a different clone folder`
        )
      }

      if (state === "fresh") {
        onProgress?.("cloning")
        await runScopedStreaming("gh-repo-clone", cloneArgs(target, dir), (line) => {
          const detail = parseGitProgress(line)
          if (detail) onProgress?.("cloning", detail)
        })
      }

      // Both paths land on the PR head: a fresh clone starts on the default branch, so the
      // fetch + detached checkout is what actually points the worktree at the PR.
      onProgress?.("fetching")
      await runScopedStreaming("git-fetch-pull", fetchArgs(dir, target.number), (line) => {
        const detail = parseGitProgress(line)
        if (detail) onProgress?.("fetching", detail)
      })

      onProgress?.("checking-out")
      await runScoped("git-checkout-detach", checkoutArgs(dir))

      return { dir, repoFiles: checkoutRepoFiles(dir) }
    },
  }
}
