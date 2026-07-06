import { Octokit } from "@octokit/rest"
import type { ChangedFile, PrMeta } from "@pr-visulizer/shared"

import type { SessionUser } from "../../entities/index.js"
import { languageForPath } from "../../utils/language.js"
import type {
  GatewayChangedFile,
  GithubGateway,
  PrTarget,
  PullRequestData,
  SubmitReviewInput,
  SubmitReviewResult,
} from "./gateway.js"

// The real gateway (docs/architecture.md §2): the ONLY module that imports Octokit,
// so the REST/GraphQL surface never leaks upstream. The token lives here, server-side.

// GitHub's file status vocabulary is wider than our contract's — clamp it (§3).
function toChangedFileStatus(status: string): ChangedFile["status"] {
  if (status === "removed") return "deleted"
  if (status === "added" || status === "modified" || status === "renamed") return status

  return "modified"
}

export function createOctokitGateway(token: string): GithubGateway {
  const octokit = new Octokit({ auth: token })

  async function getPullRequest(target: PrTarget): Promise<PullRequestData> {
    const { owner, repo, number: pull_number } = target

    const details = await octokit.pulls.get({ owner, repo, pull_number })
    const pr: PrMeta = {
      owner,
      repo,
      number: pull_number,
      title: details.data.title,
      baseSha: details.data.base.sha,
      headSha: details.data.head.sha,
    }

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

  async function getFileContent(target: PrTarget, path: string, sha: string): Promise<string> {
    const { owner, repo } = target
    const response = await octokit.repos.getContent({ owner, repo, path, ref: sha })

    // A single file returns an object with base64 `content`; anything else is unexpected.
    if (Array.isArray(response.data) || !("content" in response.data)) {
      throw new Error(`Expected file content at ${path}@${sha}`)
    }

    return Buffer.from(response.data.content, "base64").toString("utf8")
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
      })),
    })

    return { reviewId: review.data.id }
  }

  async function markFileAsViewed(target: PrTarget, path: string): Promise<void> {
    // The "Viewed" checkbox lives only in GraphQL (§11); it needs the PR node id.
    const details = await octokit.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    })

    await octokit.graphql(
      `mutation ($pullRequestId: ID!, $path: String!) {
        markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
          clientMutationId
        }
      }`,
      { pullRequestId: details.data.node_id, path }
    )
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

  return { getPullRequest, getFileContent, submitReview, markFileAsViewed, getViewer }
}
