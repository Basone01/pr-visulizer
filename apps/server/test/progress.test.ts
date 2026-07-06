import { type DraftComment, type ReviewProgress, reviewProgressSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// Progress read/write is idempotent full-state replacement (docs/architecture.md §9):
// what you PUT is what you GET back, minus the server-authoritative identity fields.

const PROGRESS_URL = "/api/prs/acme/web/42/progress"

describe("PUT then GET /progress (PR #42)", () => {
  it("round-trips reviewedFiles, drafts and verdict", async () => {
    // Arrange
    const { app } = buildTestApp()
    const reviewedFiles = ["src/config/limits.ts", "src/types/http.ts"]
    const draft: DraftComment = {
      path: "src/config/limits.ts",
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

  it("syncs reviewed files to GitHub's native Viewed state on PUT (§11)", async () => {
    // Arrange
    const { app, gateway } = buildTestApp()
    const reviewedFiles = ["src/config/limits.ts"]
    const putBody: ReviewProgress = {
      userId: "dev-user",
      owner: "acme",
      repo: "web",
      prNumber: 42,
      headSha: "head0042deadbeef",
      reviewedFiles,
      drafts: [],
    }

    // Act
    await app.inject({ method: "PUT", url: PROGRESS_URL, payload: putBody })
    const viewedPaths = gateway.viewedFiles.map((viewed) => viewed.path)

    // Assert
    expect(viewedPaths).toEqual(reviewedFiles)
  })
})
