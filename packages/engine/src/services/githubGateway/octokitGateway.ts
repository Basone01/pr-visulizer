import { Octokit } from "@octokit/rest"
import type {
  ChangedFile,
  PrCommitList,
  PrMeta,
  PrSummary,
  RangeDiff,
  RangeDiffFile,
  ReviewComment,
} from "@pr-visulizer/shared"

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

// GitHub's own ceilings on the two commit-range reads (§10). Both are documented limits, not
// guesses, and both are verified 2026-07:
//   - "Lists a maximum of 250 commits for a pull request."
//     docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request
//   - "The list of changed files is only shown on the first page of results, and it includes
//      up to 300 changed files for the entire comparison."
//     docs.github.com/en/rest/commits/commits#compare-two-commits
// Hitting either means the payload is SHORT, so we report it instead of letting the UI imply
// the list is whole.
const PR_COMMIT_LIMIT = 250
const COMPARE_FILE_LIMIT = 300

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
      // The description viewer's fields (docs.github.com pulls.get): `body` is string|null,
      // `html_url` the PR web page. Fed straight through — the panel renders the raw markdown.
      body: details.data.body ?? null,
      htmlUrl: details.data.html_url,
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

  // §10: the commits behind the diff pane's range picker. `parents` rides along because it is
  // how a range's base is derived — the first parent of the first selected commit — so the
  // picker never has to ask GitHub a second time to find a range boundary.
  async function listPrCommits(target: PrTarget): Promise<PrCommitList> {
    const { owner, repo, number: pull_number } = target

    const commits = await octokit.paginate(octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    })

    return {
      commits: commits.map((entry) => ({
        sha: entry.sha,
        parents: (entry.parents ?? []).map((parent) => parent.sha),
        // The headline is the message's first line; the body below it is not shown in a picker row.
        messageHeadline: entry.commit.message.split("\n")[0] ?? "",
        // A commit whose email matches no GitHub account has a null `author` — fall back to the
        // git-level name so the row still says who wrote it.
        author: entry.author?.login ?? entry.commit.author?.name ?? "unknown",
        authoredAt: entry.commit.author?.date ?? "",
      })),
      truncated: commits.length >= PR_COMMIT_LIMIT,
    }
  }

  // §10: the three-dot compare. Three dots is the ONLY form the endpoint documents, and it is
  // also the semantics a PR diff already has (changes on head since it diverged), so a range
  // diff and the whole-PR diff mean the same kind of thing.
  async function compareRange(
    target: PrTarget,
    baseSha: string,
    headSha: string
  ): Promise<RangeDiff> {
    const { owner, repo } = target

    const comparison = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    })

    const files: RangeDiffFile[] = (comparison.data.files ?? []).map((file) => ({
      path: file.filename,
      status: toChangedFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      previousPath: file.previous_filename ?? null,
    }))

    return { baseSha, headSha, files, truncated: files.length >= COMPARE_FILE_LIMIT }
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

  async function listReviewComments(target: PrTarget): Promise<ReviewComment[]> {
    const { owner, repo, number: pull_number } = target

    // Paginated like listFiles — a busy PR can carry hundreds of comments across pages.
    const rows = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    })

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      // `line` is absent/null on an outdated or file-level comment — carry the null through
      // rather than defaulting it, so the grouping layer can bucket it honestly.
      line: row.line ?? null,
      startLine: row.start_line ?? null,
      side: row.side === "LEFT" ? "LEFT" : "RIGHT",
      inReplyToId: row.in_reply_to_id ?? null,
      author: row.user?.login ?? "ghost",
      body: row.body,
      createdAt: row.created_at,
    }))
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
    listPrCommits,
    compareRange,
    submitReview,
    addReviewComment,
    listReviewComments,
    listViewedFiles,
    setFileViewed,
    getViewer,
  }
}
