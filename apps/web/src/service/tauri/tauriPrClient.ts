import {
  DEFAULT_REPO_SCAN,
  type GatewayChangedFile,
  type GithubGateway,
  type PrecisionPolicy,
  type PullRequestData,
  type ReviewEvent,
  type SessionUser,
  createAnalysisCache,
  createOctokitGateway,
  createViewedSyncService,
  mapWithConcurrency,
  resolvePrecisionPolicy,
  scanCandidatePaths,
  withinSizeCap,
} from "@pr-visulizer/engine"
import {
  type AnalysisResult,
  type ChangedFile,
  type CommitRange,
  type DraftComment,
  type FileHistory,
  type PrCommitList,
  type PrMeta,
  type PrOverview,
  type PrSummary,
  type RangeDiff,
  type ReviewComment,
  type ReviewProgress,
  type Viewer,
  reviewProgressSchema,
} from "@pr-visulizer/shared"
import { z } from "zod"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import { type AnalysisProgress, type AnalysisProgressListener } from "@/entity/analysisProgress"
import type { Engine, PrTarget, RepoRef } from "@/entity/pr"
import { prKey } from "@/entity/pr"
import { CLONE_ROOT_KEY, NeedsRepoSourceError, isNeedsRepoSourceError } from "@/entity/repoSource"

import { type CloneManager, createTauriCloneManager } from "@/tauri/cloneManager"
import { loadRepoLinks } from "@/tauri/repoLinks"
import {
  type PreparedRepoSource,
  type RepoSource,
  chooseRepoSource,
  createLinkedRepoSource,
  createManagedRepoSource,
} from "@/tauri/repoSource"
import { type AnalysisSources, runAnalysisInWorker } from "@/workers/runAnalysisInWorker"

import {
  type AnalysisResponse,
  type PrClient,
  REVISION_PINNED_PR_REVISION_CHANGED_MESSAGE,
  type ReviewSubmission,
  RevisionPinnedPatchError,
  type RevisionPinnedPatchSnapshot,
  type RevisionPinnedPatchSnapshotRequest,
} from "../prClient"

// The desktop data boundary (docs/tauri-architecture.md §6): the third PrClient, mapping
// every method to an in-webview implementation. The desktop is DEEP-ONLY — opening a PR runs
// the full repo-wide pipeline automatically: RepoSource prepare (linked repo preferred,
// managed clone fallback) → batch object-DB reads on the main thread → the pure deep core in
// a Web Worker (a 100+-file PR never freezes the webview). The Octokit gateway is only used for
// LIGHT PR meta (getPullMeta), open-PR lists and review submit — the changed-file list, the
// per-file patches AND the repo contents all come from local git, so opening a PR no longer
// waits on the API's paginated listFiles-with-patches. Nothing above this file knows the change.

// The deep CPU pipeline runner — the Web Worker live, the pure core directly in tests
// (jsdom/node have no Worker; the protocol has its own mocked-worker test).
export type AnalysisRunner = (
  sources: AnalysisSources,
  onProgress?: (progress: AnalysisProgress) => void
) => Promise<AnalysisResult>

// Everything the client needs, INJECTED (docs/tauri-architecture.md §6). The desktop shell
// supplies a `token` (from `gh auth token`) + the Tauri HTTP-plugin `fetch` and builds the
// Octokit gateway from them; a test injects a `gateway` (the fixture fake), a `repoSource`
// (an in-memory prepared repo) and a `runAnalysis` (the pure core called directly).
// Providing `gateway` wins over `token`/`fetch` — the mechanism beats the convenience.
export type TauriPrClientDeps = {
  // Local JSON store for review progress + repo links (Tauri Store live, in-memory in tests).
  storage: KeyValueStore
  // Desktop convenience: build the Octokit gateway from a gh token + Tauri-plugin fetch.
  token?: string
  fetch?: typeof globalThis.fetch
  // Full control / tests: inject the gateway (e.g. the fixture fake) instead.
  gateway?: GithubGateway
  // The managed-clone fallback's clone → checkout provider. Defaults to the Tauri-backed one.
  cloneManager?: CloneManager
  // Override the repo source entirely (tests inject an in-memory prepared repo).
  repoSource?: RepoSource
  // Override the worker (tests run the pure core in-process).
  runAnalysis?: AnalysisRunner
  // deep-v2 precision tier (docs/architecture.md §6.2). Defaults to the `off` preset; the
  // desktop shell passes a preset/overrides to turn it on.
  precision?: PrecisionPolicy
}

const EVENT_BY_VERDICT: Record<ReviewSubmission["verdict"], ReviewEvent> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
}

// Local-only review progress is keyed by user, PR, and head SHA (docs/tauri-architecture.md
// §6) — a new push (new SHA) starts a fresh progress record, same as the BFF's SQLite key.
function progressKey(target: PrTarget, headSha: string): string {
  return `${target.owner}/${target.repo}#${target.number}@${headSha}`
}

// On-disk JSON is a boundary like any other, so the stored ancestor is parsed, not trusted.
const viewedBaseSchema = z.array(z.string())

// GitHub's Viewed set as of the last successful sync — the two-way merge's common ancestor
// (§11). Stored under its OWN key rather than inside the progress JSON: it is sync
// bookkeeping, not the reviewer's state, and it must not ride the contract.
function viewedBaseKey(target: PrTarget, headSha: string): string {
  return `viewedBase:${progressKey(target, headSha)}`
}

function assertSnapshotRevision(meta: PrMeta, request: RevisionPinnedPatchSnapshotRequest): void {
  if (meta.baseSha !== request.baseSha || meta.headSha !== request.headSha) {
    throw new RevisionPinnedPatchError(
      "revision-changed",
      REVISION_PINNED_PR_REVISION_CHANGED_MESSAGE
    )
  }
}

// The AI patch seam may read PR IDENTITY from GitHub and nothing else. Narrowing the gateway to
// that one method is what makes "no unbounded full-PR fallback" structural rather than a habit:
// the heavy paginated `getPullRequest` is not reachable through this type.
type PrIdentityGateway = Pick<GithubGateway, "getPullMeta">

// Deliberately at MODULE scope, outside createTauriPrClient: the AI snapshot must not share the
// display path's PR-keyed prepared-reader cache or its GitHub full-PR fallback, and out here
// neither one is in scope. A fresh identity read before AND after collection means a concurrent
// push fails the whole snapshot closed instead of yielding mixed-revision context.
async function readRevisionPinnedPatchSnapshot(input: {
  gateway: PrIdentityGateway
  resolveRepoSource: (target: PrTarget) => Promise<RepoSource>
  target: PrTarget
  request: RevisionPinnedPatchSnapshotRequest
}): Promise<RevisionPinnedPatchSnapshot> {
  const { gateway, target, request } = input
  assertSnapshotRevision(await gateway.getPullMeta(target), request)

  const source = await input.resolveRepoSource(target)
  const prepared = await source.prepare(target, request.baseSha, request.headSha)

  // AI context never falls back to the gateway's paginated full-PR response. Its local reader is
  // revision-pinned and byte-bounded by the Rust `repo_file_diff` command; when that reader is
  // unavailable, the bounded assembler discloses every requested path as an explicit omission
  // rather than materializing GitHub's unbounded file list.
  if (!prepared.baseReady) {
    throw new RevisionPinnedPatchError(
      "patch-unavailable",
      "Revision-pinned local patch reader was unavailable"
    )
  }

  // `readFileDiff` is the Rust `repo_file_diff` invoke: bounded at 128 KiB, refusing over-limit
  // bytes before UTF-8 conversion. Its bare-string refusal is classified by the shared contract.
  const paths = [...new Set(request.paths)]
  const entries = await Promise.all(
    paths.map(async (path): Promise<[string, string]> => [path, await prepared.readFileDiff(path)])
  )
  const patches = Object.fromEntries(entries)

  assertSnapshotRevision(await gateway.getPullMeta(target), request)
  if (Object.keys(patches).length !== paths.length) {
    throw new RevisionPinnedPatchError(
      "patch-unavailable",
      "A requested patch was unavailable from the revision-pinned snapshot"
    )
  }

  return { baseSha: request.baseSha, headSha: request.headSha, patches }
}

function resolveGateway(deps: TauriPrClientDeps): GithubGateway {
  if (deps.gateway) return deps.gateway

  return createOctokitGateway(deps.token ?? "", deps.fetch ? { fetch: deps.fetch } : {})
}

export function createTauriPrClient(deps: TauriPrClientDeps): PrClient {
  const gateway = resolveGateway(deps)
  const viewedSync = createViewedSyncService(gateway)
  const storage = deps.storage
  const cloneManager = deps.cloneManager ?? createTauriCloneManager()
  const runAnalysis: AnalysisRunner = deps.runAnalysis ?? runAnalysisInWorker
  const precision: PrecisionPolicy = deps.precision ?? resolvePrecisionPolicy("off")

  // The cache is keyed by (headSha, tier). Without the tier in the key, one tier-OFF run would
  // serve its ast-only result to every later tier-ON open of the same PR — the precision tier
  // would look silently broken.
  const analysisTier = precision.enabled ? "deep+lsp" : "deep"

  // Deep results are immutable per headSha — re-opening the same PR re-renders instantly
  // without re-reading the repo (docs/tauri-architecture.md §6).
  const analysisCache = createAnalysisCache()

  // PR meta is immutable per session and cheap (one `pulls.get`) — cache the promise per
  // target so overview, analysis, getProgress, putProgress and submitReview all share ONE
  // light call instead of the old heavy getPullRequest (which paginated listFiles-with-patches).
  const pullMetaByKey = new Map<string, Promise<PrMeta>>()

  // The prepared local repo (head + base fetched, readers pinned), shared by overview,
  // analysis and getPatch so a single git fetch serves all three. A rejected prepare (e.g.
  // NeedsRepoSourceError before the user links a repo) is evicted so a retry can re-prepare.
  const preparedByKey = new Map<string, Promise<PreparedRepoSource>>()

  // The API changed-files-with-patches call, kept ONLY for the fallback when the local base
  // diff is unavailable — cached so overview and analysis reuse one fetch in that degraded path.
  const apiPullRequestByKey = new Map<string, Promise<PullRequestData>>()

  let viewer: Promise<SessionUser> | null = null

  // The progress seam: a queryFn can't stream, so the pipeline's onProgress feeds a
  // per-target emitter here that the useAnalysisProgress hook subscribes to. `lastProgress`
  // is replayed to a late subscriber so it isn't blank if it mounts mid-analysis.
  const listenersByPr = new Map<string, Set<AnalysisProgressListener>>()
  const lastProgressByPr = new Map<string, AnalysisProgress>()

  function emitProgress(target: PrTarget, progress: AnalysisProgress): void {
    const key = prKey(target)
    lastProgressByPr.set(key, progress)
    const listeners = listenersByPr.get(key)
    if (listeners) for (const listener of listeners) listener(progress)
  }

  // Light PR meta (one `pulls.get`) — cached per target. The desktop deep path needs only the
  // SHAs + author from the API; the file list and patches come from local git.
  function pullMeta(target: PrTarget): Promise<PrMeta> {
    const key = prKey(target)
    const cached = pullMetaByKey.get(key)
    if (cached) return cached

    const loading = gateway.getPullMeta(target)
    pullMetaByKey.set(key, loading)
    return loading
  }

  // The heavy API call, cached — used ONLY when the local base diff is unavailable, so the
  // review still renders instead of hard-failing (docs/tauri-architecture.md §6).
  function apiPullRequest(target: PrTarget): Promise<PullRequestData> {
    const key = prKey(target)
    const cached = apiPullRequestByKey.get(key)
    if (cached) return cached

    const loading = gateway.getPullRequest(target)
    apiPullRequestByKey.set(key, loading)
    return loading
  }

  function currentViewer(): Promise<SessionUser> {
    if (!viewer) viewer = gateway.getViewer()
    return viewer
  }

  function emptyProgress(target: PrTarget, userId: string, headSha: string): ReviewProgress {
    return {
      userId,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.number,
      headSha,
      reviewedFiles: [],
      drafts: [],
    }
  }

  // Desktop has no BFF, so the SAME reconcile the server route runs happens here, against the
  // same engine service and the same gateway (§11). Both reads and writes go through it: a
  // reviewer who ticks files on github.com sees them here on open, and vice versa.
  async function reconcileViewed(
    target: PrTarget,
    headSha: string,
    progress: ReviewProgress
  ): Promise<ReviewProgress> {
    const baseKey = viewedBaseKey(target, headSha)
    const storedBase = await storage.get(baseKey)
    const base = storedBase === null ? null : viewedBaseSchema.parse(JSON.parse(storedBase))

    const reconciled = await viewedSync.reconcile({
      target,
      local: progress.reviewedFiles,
      base,
    })

    const saved: ReviewProgress = { ...progress, reviewedFiles: reconciled.reviewedFiles }
    await storage.set(progressKey(target, headSha), JSON.stringify(saved))

    // Only advance the ancestor once GitHub confirmed the write, so a failed sync cannot be
    // mistaken for "GitHub agreed with us" on the next merge.
    if (reconciled.syncedViewedFiles) {
      await storage.set(baseKey, JSON.stringify(reconciled.syncedViewedFiles))
    }

    return { ...saved, viewedSync: reconciled.sync }
  }

  // Where to read the repo from: the user's linked clone if one is registered for this
  // owner/repo, else the managed clone dir. Neither → the typed error the UI turns into
  // the locate-vs-clone prompt (docs/tauri-architecture.md §6).
  async function resolveRepoSource(target: PrTarget): Promise<RepoSource> {
    if (deps.repoSource) return deps.repoSource

    const links = await loadRepoLinks(storage)
    const cloneRoot = await storage.get(CLONE_ROOT_KEY)
    const choice = chooseRepoSource(links, cloneRoot, target)

    if (choice.kind === "linked") return createLinkedRepoSource(choice.link)
    if (choice.kind === "managed") return createManagedRepoSource(cloneManager, choice.cloneRoot)

    throw new NeedsRepoSourceError(target.owner, target.repo)
  }

  // Prepare the local repo ONCE per target and share it: git-fetch the PR head + base object,
  // pin the readers, cache the promise. Overview, analysis and getPatch all await this, so a
  // single fetch serves all three. A rejection (NeedsRepoSourceError, or a fetch failure) is
  // evicted so a later retry — e.g. after the user links a repo — re-prepares cleanly.
  function prepareDeep(target: PrTarget): Promise<PreparedRepoSource> {
    const key = prKey(target)
    const cached = preparedByKey.get(key)
    if (cached) return cached

    const loading = (async () => {
      const meta = await pullMeta(target)
      const source = await resolveRepoSource(target)
      emitProgress(target, { step: "preparing-repo" })

      return source.prepare(target, meta.baseSha, meta.headSha, (phase, detail) => {
        emitProgress(target, {
          step: "preparing-repo",
          detail: detail ? `${phase} — ${detail}` : `${phase}…`,
        })
      })
    })()

    preparedByKey.set(key, loading)
    loading.catch(() => preparedByKey.delete(key))
    return loading
  }

  // Only modified/renamed files need a patch — the deep engine maps head hunk ranges to the
  // symbols that changed (changedSymbols.ts). Added files change ALL their symbols and deleted
  // files have no head content, so both skip the per-file diff.
  function patchNeededFor(status: ChangedFile["status"]): boolean {
    return status === "modified" || status === "renamed"
  }

  // The changed-file set fed to the analysis, WITH patches for the modified/renamed files. From
  // local git when the base diff is available; otherwise the API (logged) so the review still runs.
  async function changedFilesForAnalysis(
    target: PrTarget,
    prepared: PreparedRepoSource
  ): Promise<GatewayChangedFile[]> {
    if (!prepared.baseReady) {
      console.warn(
        `[tauriPrClient] local base diff unavailable for ${prKey(target)} — using GitHub API patches`
      )
      const { files } = await apiPullRequest(target)
      return files
    }

    const list = await prepared.listChangedFiles()

    // Each readFileDiff spawns its own `git diff` child through a Tauri invoke (~15 ms), so
    // awaiting them one at a time cost ~4.5 s of dead time before parsing could start on a
    // 300-file PR. Fan them out through the same bounded pool the checkout reads use.
    const patches = await mapWithConcurrency(
      list,
      DEFAULT_REPO_SCAN.readConcurrency,
      async (file) => (patchNeededFor(file.status) ? prepared.readFileDiff(file.path) : null)
    )

    return list.map((file, index) => ({ ...file, patch: patches[index]! }))
  }

  // The overview's provisional file list: local when available, the API when the base diff
  // isn't, and an EMPTY list when no repo source is linked yet — the shell must still render so
  // the analysis query's NeedsRepoSourceError can surface the locate-vs-clone prompt.
  async function changedFilesForOverview(target: PrTarget): Promise<ChangedFile[]> {
    try {
      const prepared = await prepareDeep(target)
      if (prepared.baseReady) return prepared.listChangedFiles()

      const { files } = await apiPullRequest(target)
      return files.map(toChangedFile)
    } catch (error) {
      if (isNeedsRepoSourceError(error)) return []

      throw error
    }
  }

  // THE analysis (deep-only desktop): prepare the local repo, batch-read the scan candidates
  // from the object DB (main thread — workers have no Tauri APIs), assemble the changed-file
  // set, then run the pure deep core in the worker. Every phase feeds the progress emitter.
  async function runDeepAnalysis(target: PrTarget): Promise<AnalysisResult> {
    emitProgress(target, { step: "fetching-pr" })
    const pr = await pullMeta(target)

    const cached = analysisCache.get(pr.headSha, analysisTier)
    if (cached) return cached

    const prepared = await prepareDeep(target)

    const paths = await prepared.listFiles()
    const candidates = scanCandidatePaths(paths, DEFAULT_REPO_SCAN)
    emitProgress(target, { step: "reading-files", done: 0, total: candidates.length })
    const raw = await prepared.readMany(candidates, (done, total) =>
      emitProgress(target, { step: "reading-files", done, total })
    )

    // The same size gate the engine's own reader applies — a giant generated file is
    // skipped, never parsed.
    const contents = new Map<string, string>()
    for (const [path, content] of raw) {
      if (withinSizeCap(content, DEFAULT_REPO_SCAN)) contents.set(path, content)
    }

    const files = await changedFilesForAnalysis(target, prepared)

    const result = await runAnalysis({ pr, files, contents, precision }, (progress) =>
      emitProgress(target, progress)
    )

    analysisCache.set(pr.headSha, analysisTier, result)
    return result
  }

  // Drop a gateway file's patch — the overview never needs it (PrOverview.files is ChangedFile).
  function toChangedFile(file: GatewayChangedFile): ChangedFile {
    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      language: file.language,
    }
  }

  return {
    async getOverview(target: PrTarget): Promise<PrOverview> {
      const [pr, files] = await Promise.all([pullMeta(target), changedFilesForOverview(target)])
      return { pr, files }
    },

    // Desktop is deep-only (owner decision — fast stays the BFF/browser path): the requested
    // engine is ignored, the deep pipeline IS the analysis.
    async getAnalysis(target: PrTarget, _engine: Engine): Promise<AnalysisResponse> {
      const result = await runDeepAnalysis(target)
      return { status: "ready", result }
    },

    subscribeAnalysisProgress(target: PrTarget, listener: AnalysisProgressListener): () => void {
      const key = prKey(target)
      const listeners = listenersByPr.get(key) ?? new Set<AnalysisProgressListener>()
      listeners.add(listener)
      listenersByPr.set(key, listeners)

      // Replay the last known step so a late subscriber renders the current state, not blank.
      const last = lastProgressByPr.get(key)
      if (last) listener(last)

      return () => {
        listeners.delete(listener)
      }
    },

    // The diff view, lazy per file: the file's patch computed locally over base...head. Falls
    // back to the API patch when there's no linked repo or the base object couldn't be fetched.
    async getPatch(target: PrTarget, path: string): Promise<string> {
      try {
        const prepared = await prepareDeep(target)
        if (prepared.baseReady) {
          const diff = await prepared.readFileDiff(path)
          // Only return a real local diff; an empty one (stale/mismatched base) falls
          // THROUGH to the API patch below rather than erroring out of this file.
          if (diff.trim().length > 0) return diff
        }
      } catch (error) {
        if (!isNeedsRepoSourceError(error)) throw error
        // No repo source — fall through to the API patch below.
      }

      const { files } = await apiPullRequest(target)
      const patch = files.find((file) => file.path === path)?.patch ?? null
      if (patch === null) throw new Error(`no diff available for ${path}`)

      return patch
    },

    // AI context and draft-anchor revalidation delegate to the module-scope reader above, which
    // cannot see this closure's heavy gateway call or its PR-keyed display caches.
    getRevisionPinnedPatchSnapshot(target, request) {
      return readRevisionPinnedPatchSnapshot({ gateway, resolveRepoSource, target, request })
    },

    // The desktop half of the refresh button. Three memos here are keyed by PR with NO head SHA
    // — the light PR meta, the prepared repo (fetched pinned at base/head) and the API
    // file-list fallback — so a PR that gained commits would keep re-serving the head the app
    // opened on. The analysis cache is deliberately KEPT: it is keyed by headSha, so a new push
    // misses it on its own and an unchanged head still re-renders instantly.
    invalidatePr(target: PrTarget): Promise<void> {
      const key = prKey(target)
      pullMetaByKey.delete(key)
      preparedByKey.delete(key)
      apiPullRequestByKey.delete(key)

      return Promise.resolve()
    },

    // §10 commit-range picker. Both reads go to the API rather than the local clone: the clone
    // is fetched pinned at base/head for the analysis, so an arbitrary intermediate commit's
    // objects may simply not be present locally, and a compare is one cheap call.
    listCommits(target: PrTarget): Promise<PrCommitList> {
      return gateway.listPrCommits(target)
    },

    getRangeDiff(target: PrTarget, range: CommitRange): Promise<RangeDiff> {
      return gateway.compareRange(target, range.baseSha, range.headSha)
    },

    // §10 file history. Goes to the API rather than the local clone for the same reason as the
    // picker above: the clone is pinned at base/head, so the PR's intermediate commits, the very
    // thing this lists, may not be present locally.
    getFileHistory(target: PrTarget, path: string): Promise<FileHistory> {
      return gateway.listPrCommitsForPath(target, path)
    },

    // The full-file view's head content (§10). The prepared repo already exposes a read pinned
    // at the head SHA (the same object-DB batch read the analysis feeds on) — no new Tauri
    // command, no API call. Anything that makes the file unreadable HERE (no repo source yet,
    // a deleted path, a binary blob) is "unavailable", not an error: the pane keeps rendering
    // the hunks and the toggle explains itself.
    async getFileAtHead(target: PrTarget, path: string): Promise<string | null> {
      try {
        const prepared = await prepareDeep(target)
        return await prepared.readFile(path)
      } catch {
        return null
      }
    },

    async getProgress(target: PrTarget): Promise<ReviewProgress> {
      const [pr, user] = await Promise.all([pullMeta(target), currentViewer()])
      const stored = await storage.get(progressKey(target, pr.headSha))

      // Parse-don't-trust survives the platform change: on-disk JSON is a boundary too.
      const local =
        stored === null
          ? emptyProgress(target, user.userId, pr.headSha)
          : reviewProgressSchema.parse(JSON.parse(stored))

      return reconcileViewed(target, pr.headSha, local)
    },

    async putProgress(target: PrTarget, progress: ReviewProgress): Promise<ReviewProgress> {
      const [pr, user] = await Promise.all([pullMeta(target), currentViewer()])

      // Server-authoritative identity, locally: the caller only owns files/drafts/verdict.
      // `viewedSync` is derived by the reconcile below, never taken from the caller.
      const saved: ReviewProgress = {
        userId: user.userId,
        owner: target.owner,
        repo: target.repo,
        prNumber: target.number,
        headSha: pr.headSha,
        reviewedFiles: progress.reviewedFiles,
        drafts: progress.drafts,
        ...(progress.verdict ? { verdict: progress.verdict } : {}),
      }

      return reconcileViewed(target, pr.headSha, saved)
    },

    async addCommentNow(target: PrTarget, comment: DraftComment): Promise<void> {
      // Same anchor as a review submit: the PR's head commit (§11).
      const pr = await pullMeta(target)
      await gateway.addReviewComment({ target, commitId: pr.headSha, comment })
    },

    listReviewComments(target: PrTarget): Promise<ReviewComment[]> {
      return gateway.listReviewComments(target)
    },

    // Straight to the gateway like every other comment call — nothing here is memoized, so the
    // caller's list refetch reads the edit back from GitHub without a cache to drop first.
    async updateReviewComment(target: PrTarget, commentId: number, body: string): Promise<void> {
      await gateway.updateReviewComment({ target, commentId, body })
    },

    async submitReview(target: PrTarget, submission: ReviewSubmission): Promise<void> {
      const pr = await pullMeta(target)
      await gateway.submitReview({
        target,
        commitId: pr.headSha,
        event: EVENT_BY_VERDICT[submission.verdict],
        body: submission.body,
        comments: submission.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body,
          // Forward the range start; the octokit gateway maps it to GitHub start_line (§11).
          ...(comment.startLine !== undefined ? { startLine: comment.startLine } : {}),
        })),
      })
    },

    listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]> {
      return gateway.listOpenPullRequests(repo)
    },

    // The gateway's SessionUser IS the viewer shape (structurally identical, §12); reuse the
    // cached fetch so the own-PR Approve guard shares it with getProgress/putProgress.
    getViewer(): Promise<Viewer> {
      return currentViewer()
    },
  }
}
