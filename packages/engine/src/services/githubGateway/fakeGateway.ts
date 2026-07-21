import type { PrMeta, PrSummary } from "@pr-visulizer/shared"

import type { SessionUser } from "../../entities/index.js"
import { PR42_CONTENTS, PR42_FILES, PR42_META } from "./fixtures/pr42.js"
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

// A complete fixture PR: meta + changed files + head-version contents.
export type GatewayFixture = {
  meta: PrMeta
  files: GatewayChangedFile[]
  contents: Record<string, string>
}

// The fixture-backed gateway (docs/architecture.md §5 step-by-step, testable
// without GitHub). Boots when GITHUB_FAKE=1. Same interface as the Octokit impl,
// so nothing upstream knows which one it holds. It also RECORDS the write calls
// (reviews, viewed-file syncs) so tests can assert what was forwarded to GitHub.
export type FakeGithubGateway = GithubGateway & {
  submittedReviews: SubmitReviewInput[]
  addedComments: AddReviewCommentInput[]
  // Every viewed-state WRITE in order, so a test can assert what was forwarded and in which
  // direction — a mark and an unmark are both meaningful now that the sync runs both ways.
  viewedWrites: Array<{ target: PrTarget; path: string; viewed: boolean }>
  // Stand in for a reviewer ticking "Viewed" on github.com, so the merge is drivable from
  // the REMOTE side in a test without any network.
  setRemoteViewed(target: PrTarget, path: string, viewed: boolean): void
}

const DEV_VIEWER: SessionUser = {
  userId: "fake-user-1",
  login: "octocat",
  name: "The Octocat",
  avatarUrl: null,
}

// A stable synthetic timestamp so the fake picker has a deterministic updated-at to sort
// and render (real GitHub sends the PR's own updated_at).
const FIXTURE_UPDATED_AT = "2026-07-01T12:00:00.000Z"

function fixtureKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`
}

export function pr42Fixture(): GatewayFixture {
  return { meta: PR42_META, files: PR42_FILES, contents: PR42_CONTENTS }
}

// Defaults to the PR #42 fixture; extra fixtures (e.g. an unknown-language PR for the
// heuristic-fallback test) can be supplied. A later fixture with the same key wins.
export function createFakeGithubGateway(
  fixtures: GatewayFixture[] = [pr42Fixture()]
): FakeGithubGateway {
  const byKey = new Map<string, GatewayFixture>()
  for (const fixture of fixtures) {
    byKey.set(fixtureKey(fixture.meta.owner, fixture.meta.repo, fixture.meta.number), fixture)
  }

  const submittedReviews: SubmitReviewInput[] = []
  const addedComments: AddReviewCommentInput[] = []
  const viewedWrites: Array<{ target: PrTarget; path: string; viewed: boolean }> = []

  // GitHub's own Viewed checkboxes, per PR — the fake holds real state rather than only
  // recording calls, so a round-trip (write here, read it back) behaves like the real thing.
  const remoteViewedByPr = new Map<string, Set<string>>()

  function remoteViewed(target: PrTarget): Set<string> {
    const key = fixtureKey(target.owner, target.repo, target.number)
    const existing = remoteViewedByPr.get(key)
    if (existing) return existing

    const created = new Set<string>()
    remoteViewedByPr.set(key, created)
    return created
  }

  function lookupFixture(target: PrTarget): GatewayFixture {
    const key = fixtureKey(target.owner, target.repo, target.number)
    const found = byKey.get(key)
    if (!found) throw new Error(`No fixture for ${key}`)

    return found
  }

  return {
    submittedReviews,
    addedComments,
    viewedWrites,

    setRemoteViewed(target: PrTarget, path: string, viewed: boolean): void {
      if (viewed) remoteViewed(target).add(path)
      else remoteViewed(target).delete(path)
    },

    async getPullMeta(target: PrTarget): Promise<PrMeta> {
      return lookupFixture(target).meta
    },

    async getPullRequest(target: PrTarget): Promise<PullRequestData> {
      const fixture = lookupFixture(target)
      return { pr: fixture.meta, files: fixture.files }
    },

    async listOpenPullRequests(repo: RepoRef): Promise<PrSummary[]> {
      // Every fixture whose meta matches this repo becomes an open-PR row.
      const summaries: PrSummary[] = []
      for (const fixture of byKey.values()) {
        if (fixture.meta.owner !== repo.owner || fixture.meta.repo !== repo.repo) continue

        summaries.push({
          number: fixture.meta.number,
          title: fixture.meta.title,
          author: DEV_VIEWER.login,
          updatedAt: FIXTURE_UPDATED_AT,
        })
      }

      return summaries
    },

    async getFileContent(target: PrTarget, path: string): Promise<string> {
      const fixture = lookupFixture(target)
      const content = fixture.contents[path]
      if (content === undefined) throw new Error(`No fixture content for ${path}`)

      return content
    },

    async submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult> {
      submittedReviews.push(input)
      return { reviewId: submittedReviews.length }
    },

    async addReviewComment(input: AddReviewCommentInput): Promise<void> {
      addedComments.push(input)
    },

    async listViewedFiles(target: PrTarget): Promise<Record<string, ViewedFileState>> {
      // Only the PR's own changed files have a viewed state on GitHub, so report every one
      // of them — the unticked ones as UNVIEWED, exactly like the real connection does.
      const states: Record<string, ViewedFileState> = {}
      const viewed = remoteViewed(target)

      for (const file of lookupFixture(target).files) {
        states[file.path] = viewed.has(file.path) ? "VIEWED" : "UNVIEWED"
      }

      return states
    },

    async setFileViewed(target: PrTarget, path: string, viewed: boolean): Promise<void> {
      viewedWrites.push({ target, path, viewed })
      if (viewed) remoteViewed(target).add(path)
      else remoteViewed(target).delete(path)
    },

    async getViewer(): Promise<SessionUser> {
      return DEV_VIEWER
    },
  }
}
