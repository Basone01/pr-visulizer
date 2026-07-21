import {
  type FakeGithubGateway,
  type GithubGateway,
  createFakeGithubGateway,
} from "@pr-visulizer/engine"
import { type DraftComment, type ReviewProgress, reviewProgressSchema } from "@pr-visulizer/shared"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { buildApp } from "../src/app.js"
import { loadEnv } from "../src/config/env.js"
import { buildTestApp } from "./helpers/buildTestApp.js"

// Progress read/write is idempotent full-state replacement (docs/architecture.md §9):
// what you PUT is what you GET back, minus the server-authoritative identity fields.
// Both verbs also reconcile the checkmarks with GitHub's own "Viewed" state, in BOTH
// directions (§11) — that is what the second block covers.

const PROGRESS_URL = "/api/prs/acme/web/42/progress"

const LIMITS = "src/config/limits.ts"
const HTTP = "src/types/http.ts"

const target = { owner: "acme", repo: "web", number: 42 }

function progressBody(reviewedFiles: string[]): ReviewProgress {
  return {
    userId: "dev-user",
    owner: "acme",
    repo: "web",
    prNumber: 42,
    headSha: "head0042deadbeef",
    reviewedFiles,
    drafts: [],
  }
}

// Boot the app over a gateway whose viewed-state WRITES always fail, so the degraded path is
// reachable without a network. Reads still work, which is the realistic failure (a token that
// can read the PR but no longer has write scope).
function buildAppWithFailingViewedWrites(failure: Error): {
  app: ReturnType<typeof buildApp>
  gateway: FakeGithubGateway
} {
  const env = loadEnv({ GITHUB_FAKE: "1", DATABASE_URL: ":memory:" })
  const gateway = createFakeGithubGateway()
  const failingGateway: GithubGateway = {
    ...gateway,
    setFileViewed: vi.fn(async () => {
      throw failure
    }),
  }
  const app = buildApp({ env, gateway: failingGateway })

  onTestFinished(async () => {
    await app.close()
  })

  return { app, gateway }
}

describe("PUT then GET /progress (PR #42)", () => {
  it("round-trips reviewedFiles, drafts and verdict", async () => {
    // Arrange
    const { app } = buildTestApp()
    const reviewedFiles = [LIMITS, HTTP]
    const draft: DraftComment = {
      path: LIMITS,
      line: 8,
      side: "RIGHT",
      body: "extract 60_000 into a named constant",
    }
    const verdict = "approve" as const
    // Identity fields are deliberately wrong — the server must overwrite them.
    const putBody: ReviewProgress = {
      userId: "spoofed",
      owner: "spoofed",
      repo: "spoofed",
      prNumber: 1,
      headSha: "spoofed",
      reviewedFiles,
      drafts: [draft],
      verdict,
    }

    // Act
    await app.inject({ method: "PUT", url: PROGRESS_URL, payload: putBody })
    const getResponse = await app.inject({ method: "GET", url: PROGRESS_URL })
    const saved = reviewProgressSchema.parse(getResponse.json())

    // Assert
    const expected = { reviewedFiles, drafts: [draft], verdict }
    expect({
      reviewedFiles: saved.reviewedFiles,
      drafts: saved.drafts,
      verdict: saved.verdict,
    }).toEqual(expected)
  })
})

describe("two-way GitHub Viewed sync (§11)", () => {
  it("pushes a checked file to GitHub's native Viewed state on PUT", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const reviewedFiles = [LIMITS]

    // Act
    await app.inject({ method: "PUT", url: PROGRESS_URL, payload: progressBody(reviewedFiles) })

    // Assert — one write, in the mark direction.
    const expected = [{ target, path: LIMITS, viewed: true }]
    expect(gateway.viewedWrites).toEqual(expected)
  })

  it("pulls a file the reviewer ticked on github.com into the checkmarks on GET", async () => {
    // Arrange — nothing has ever been checked in the app; GitHub says one file is viewed.
    const { app, gateway } = buildTestApp()
    gateway.setRemoteViewed(target, HTTP, true)

    // Act
    const response = await app.inject({ method: "GET", url: PROGRESS_URL })
    const progress = reviewProgressSchema.parse(response.json())

    // Assert
    const expected = { reviewedFiles: [HTTP], viewedSync: { status: "synced" } }
    expect({
      reviewedFiles: progress.reviewedFiles,
      viewedSync: progress.viewedSync,
    }).toEqual(expected)
  })

  it("drops a checkmark for a file un-viewed on github.com after the last sync", async () => {
    // Arrange — a PUT establishes the ancestor, then the reviewer unticks it on github.com.
    const { app, gateway } = buildTestApp()
    await app.inject({ method: "PUT", url: PROGRESS_URL, payload: progressBody([LIMITS, HTTP]) })
    gateway.setRemoteViewed(target, HTTP, false)

    // Act
    const response = await app.inject({ method: "GET", url: PROGRESS_URL })
    const progress = reviewProgressSchema.parse(response.json())

    // Assert — the un-view wins instead of the stale local checkmark re-adding it.
    const expected = [LIMITS]
    expect(progress.reviewedFiles).toEqual(expected)
  })

  it("keeps the checkmark and reports degraded when the GitHub write fails", async () => {
    // Arrange
    const failure = new Error("Resource not accessible by personal access token")
    const { app } = buildAppWithFailingViewedWrites(failure)
    const reviewedFiles = [LIMITS]

    // Act
    const response = await app.inject({
      method: "PUT",
      url: PROGRESS_URL,
      payload: progressBody(reviewedFiles),
    })
    const progress = reviewProgressSchema.parse(response.json())

    // Assert — the reviewer's work survives a GitHub failure; the UI is told sync is degraded.
    const expected = {
      reviewedFiles,
      viewedSync: { status: "degraded", reason: failure.message },
    }
    expect({
      reviewedFiles: progress.reviewedFiles,
      viewedSync: progress.viewedSync,
    }).toEqual(expected)
  })

  it("does not let a client declare its own sync healthy", async () => {
    // Arrange — a spoofed body claims synced while GitHub writes are failing.
    const failure = new Error("offline")
    const { app } = buildAppWithFailingViewedWrites(failure)
    const spoofed: ReviewProgress = {
      ...progressBody([LIMITS]),
      viewedSync: { status: "synced" },
    }

    // Act
    const response = await app.inject({ method: "PUT", url: PROGRESS_URL, payload: spoofed })
    const progress = reviewProgressSchema.parse(response.json())

    // Assert — viewedSync is server-derived, so the body's claim is discarded.
    const expected = { status: "degraded", reason: failure.message }
    expect(progress.viewedSync).toEqual(expected)
  })
})
