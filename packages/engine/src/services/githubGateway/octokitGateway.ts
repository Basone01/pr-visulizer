import { Octokit } from "@octokit/rest"
import type { ChangedFile, PrMeta, PrSummary } from "@pr-visulizer/shared"

import type { SessionUser } from "../../entities/index.js"
import { decodeBase64Utf8 } from "../../utils/base64.js"
import { languageForPath } from "../../utils/language.js"
import type {
  AddReviewCommentInput,
  GatewayChangedFile,
  GithubGateway,
  PrTarget,
  PullRequestData,
  RepoRef,
  SubmitReviewInput,
  SubmitReviewResult,
  ViewedFileState,
} from "./gateway.js"

// The real gateway (docs/architecture.md §2): the ONLY module that imports Octokit,
// so the REST/GraphQL surface never leaks upstream. The token lives here, server-side.

// An injected fetch (§3 seam 2). The node BFF uses the global fetch (default); the
// webview passes Tauri's HTTP-plugin fetch so browser CORS rules don't apply.
export type OctokitGatewayOptions = {
  fetch?: typeof globalThis.fetch
}

// The three GraphQL documents behind the "Viewed" sync (§11). Shapes verified 2026-07 against
// the live schema: both mutations take `MarkFileAsViewedInput`/`UnmarkFileAsViewedInput` of
// { pullRequestId: ID!, path: String! }, and `PullRequestChangedFile.viewerViewedState` is a
// non-null `FileViewedState`. There is NO REST equivalent for any of it.
const VIEWED_FILES_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { path viewerViewedState }
        }
      }
    }
  }
`

const MARK_FILE_AS_VIEWED = `
  mutation ($pullRequestId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
      clientMutationId
    }
  }
`

const UNMARK_FILE_AS_VIEWED = `
  mutation ($pullRequestId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
      clientMutationId
    }
  }
`

// The shape the query above returns. Every level is nullable because GraphQL answers a
// missing repo/PR with nulls beside an error rather than a 404.
type ViewedFilesPage = {
  repository: {
    pullRequest: {
      files: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<{ path: string; viewerViewedState: ViewedFileState } | null> | null
      } | null
    } | null
  } | null
}

// GitHub's file status vocabulary is wider than our contract's — clamp it (§3).
function toChangedFileStatus(status: string): ChangedFile["status"] {
  if (status === "removed") return "deleted"
  if (status === "added" || status === "modified" || status === "renamed") return status

  return "modified"
}

export function createOctokitGateway(
  token: string,
  options: OctokitGatewayOptions = {}
): GithubGateway {
  const octokit = new Octokit({
    auth: token,
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  })

  async function getPullMeta(target: PrTarget): Promise<PrMeta> {
    const { owner, repo, number: pull_number } = target

    const details = await octokit.pulls.get({ owner, repo, pull_number })
    return {
      owner,
      repo,
      number: pull_number,
      title: details.data.title,
      author: details.data.user?.login ?? "unknown",
      baseSha: details.data.base.sha,
      headSha: details.data.head.sha,
    }
  }

  async function getPullRequest(target: PrTarget): Promise<PullRequestData> {
    const { owner, repo, number: pull_number } = target

    // The meta is the same single `pulls.get`; the pagination below is the heavy part.
    const pr = await getPullMeta(target)

    const changed = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    })

    const files: GatewayChangedFile[] = changed.map((file) => ({
      path: file.filename,
      status: toChangedFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      language: languageForPath(file.filename),
      patch: file.patch ?? null,
    }))

    return { pr, files }
  }

  async function listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]> {
    const pulls = await octokit.paginate(octokit.pulls.list, {
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    })

    return pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      author: pull.user?.login ?? "unknown",
      updatedAt: pull.updated_at,
    }))
  }

  async function getFileContent(target: PrTarget, path: string, sha: string): Promise<string> {
    const { owner, repo } = target
    const response = await octokit.repos.getContent({ owner, repo, path, ref: sha })

    // A single file returns an object with base64 `content`; anything else is unexpected.
    if (Array.isArray(response.data) || !("content" in response.data)) {
      throw new Error(`Expected file content at ${path}@${sha}`)
    }

    return decodeBase64Utf8(response.data.content)
  }

  async function submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult> {
    const { owner, repo, number: pull_number } = input.target

    const review = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id: input.commitId,
      event: input.event,
      body: input.body,
      comments: input.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        // GitHub multi-line comment: send start_line + start_side ONLY for a real range
        // (a startLine strictly before the last line), never for a single-line comment (§11).
        ...(comment.startLine !== undefined && comment.startLine < comment.line
          ? { start_line: comment.startLine, start_side: comment.side }
          : {}),
      })),
    })

    return { reviewId: review.data.id }
  }

  async function addReviewComment(input: AddReviewCommentInput): Promise<void> {
    const { owner, repo, number: pull_number } = input.target
    const { comment } = input

    await octokit.pulls.createReviewComment({
      owner,
      repo,
      pull_number,
      commit_id: input.commitId,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
      // Same range rule as submitReview: start_line only for a real multi-line range (§11).
      ...(comment.startLine !== undefined && comment.startLine < comment.line
        ? { start_line: comment.startLine, start_side: comment.side }
        : {}),
    })
  }

  // Both viewed-state mutations key off the PR's GraphQL node id, and a sync writes several
  // files at once — resolving it once per target turns what used to be one REST `pulls.get`
  // PER FILE PER SAVE into a single call for the whole session.
  const nodeIdByTarget = new Map<string, Promise<string>>()

  function pullNodeId(target: PrTarget): Promise<string> {
    const key = `${target.owner}/${target.repo}#${target.number}`
    const cached = nodeIdByTarget.get(key)
    if (cached) return cached

    const loading = octokit.pulls
      .get({ owner: target.owner, repo: target.repo, pull_number: target.number })
      .then((details) => details.data.node_id)

    nodeIdByTarget.set(key, loading)
    return loading
  }

  async function listViewedFiles(target: PrTarget): Promise<Record<string, ViewedFileState>> {
    const states: Record<string, ViewedFileState> = {}

    // `pullRequest.files` is a Relay connection, so a 400-file PR needs the cursor loop —
    // stopping at the first page would silently report every later file as unviewed.
    let after: string | null = null
    for (;;) {
      const page: ViewedFilesPage = await octokit.graphql(VIEWED_FILES_QUERY, {
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        after,
      })

      const files = page.repository?.pullRequest?.files
      if (!files) break

      for (const node of files.nodes ?? []) {
        if (node) states[node.path] = node.viewerViewedState
      }

      if (!files.pageInfo.hasNextPage) break

      after = files.pageInfo.endCursor
    }

    return states
  }

  async function setFileViewed(target: PrTarget, path: string, viewed: boolean): Promise<void> {
    const pullRequestId = await pullNodeId(target)
    const mutation = viewed ? MARK_FILE_AS_VIEWED : UNMARK_FILE_AS_VIEWED

    await octokit.graphql(mutation, { pullRequestId, path })
  }

  async function getViewer(): Promise<SessionUser> {
    const viewer = await octokit.users.getAuthenticated()
    return {
      userId: String(viewer.data.id),
      login: viewer.data.login,
      name: viewer.data.name ?? null,
      avatarUrl: viewer.data.avatar_url ?? null,
    }
  }

  return {
    getPullMeta,
    getPullRequest,
    listOpenPullRequests,
    getFileContent,
    submitReview,
    addReviewComment,
    listViewedFiles,
    setFileViewed,
    getViewer,
  }
}
