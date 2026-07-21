import { PR42_COMMIT_SHAS, PR42_META, PR42_PATHS } from "@pr-visulizer/engine"
import { commitRange, prCommitListSchema, rangeDiffSchema } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import { buildTestApp } from "./helpers/buildTestApp.js"

// Commit-range selection over HTTP (§10): the picker's commit list and the range compare, both
// served through the gateway and parsed against the shared contract on the way out.

const COMMITS_URL = "/api/prs/acme/web/42/commits"
const COMPARE_URL = "/api/prs/acme/web/42/compare"

describe("GET /commits (PR #42)", () => {
  it("serves the PR's commits with the parent shas the range base is derived from", async () => {
    // Arrange
    const { app } = buildTestApp()

    // Act
    const response = await app.inject({ method: "GET", url: COMMITS_URL })
    const body = prCommitListSchema.parse(response.json())

    // Assert — every commit must carry a parent, or no range base can be derived from it.
    const expected = {
      statusCode: 200,
      shas: [PR42_COMMIT_SHAS.config, PR42_COMMIT_SHAS.limiter, PR42_COMMIT_SHAS.wiring],
      firstCommitParent: PR42_META.baseSha,
      truncated: false,
    }
    expect({
      statusCode: response.statusCode,
      shas: body.commits.map((commit) => commit.sha),
      firstCommitParent: body.commits[0]?.parents[0],
      truncated: body.truncated,
    }).toEqual(expected)
  })
})

describe("GET /compare (PR #42)", () => {
  it("restricts the diff to a single selected commit", async () => {
    // Arrange
    const { app } = buildTestApp()
    const baseSha = PR42_COMMIT_SHAS.config // the parent of the limiter commit
    const headSha = PR42_COMMIT_SHAS.limiter

    // Act
    const response = await app.inject({
      method: "GET",
      url: `${COMPARE_URL}?base=${baseSha}&head=${headSha}`,
    })
    const body = rangeDiffSchema.parse(response.json())

    // Assert — only the limiter commit's two files, each with a patch to render.
    const expected = {
      statusCode: 200,
      paths: [PR42_PATHS.rateLimiter, PR42_PATHS.test].sort(),
      allHavePatches: true,
      truncated: false,
    }
    expect({
      statusCode: response.statusCode,
      paths: body.files.map((file) => file.path).sort(),
      allHavePatches: body.files.every((file) => file.patch !== null),
      truncated: body.truncated,
    }).toEqual(expected)
  })

  it("spans a contiguous two-commit range, using the FIRST commit's parent as the base", async () => {
    // Arrange
    const { app } = buildTestApp()
    const commitsResponse = await app.inject({ method: "GET", url: COMMITS_URL })
    const { commits } = prCommitListSchema.parse(commitsResponse.json())
    const firstSelected = commits[0]
    const lastSelected = commits[1]
    if (!firstSelected || !lastSelected) throw new Error("fixture must have two commits")

    const range = commitRange(firstSelected, lastSelected, PR42_META.baseSha)

    // Act
    const response = await app.inject({
      method: "GET",
      url: `${COMPARE_URL}?base=${range.baseSha}&head=${range.headSha}`,
    })
    const body = rangeDiffSchema.parse(response.json())

    // Assert — the union of both commits' files, based at the PR base (commit 1's parent).
    const expected = {
      baseSha: PR42_META.baseSha,
      paths: [PR42_PATHS.http, PR42_PATHS.limits, PR42_PATHS.rateLimiter, PR42_PATHS.test].sort(),
    }
    expect({ baseSha: body.baseSha, paths: body.files.map((file) => file.path).sort() }).toEqual(
      expected
    )
  })

  it("omits a file no commit in the range touched", async () => {
    // Arrange — the config commit never touches the login route (that is the wiring commit).
    const { app } = buildTestApp()
    const baseSha = PR42_META.baseSha
    const headSha = PR42_COMMIT_SHAS.config
    const untouchedPath = PR42_PATHS.login

    // Act
    const response = await app.inject({
      method: "GET",
      url: `${COMPARE_URL}?base=${baseSha}&head=${headSha}`,
    })
    const body = rangeDiffSchema.parse(response.json())

    // Assert
    const expected = false
    expect(body.files.some((file) => file.path === untouchedPath)).toEqual(expected)
  })

  it("rejects a compare with a missing range end", async () => {
    // Arrange
    const { app } = buildTestApp()
    const headOnly = `${COMPARE_URL}?head=${PR42_COMMIT_SHAS.wiring}`

    // Act
    const response = await app.inject({ method: "GET", url: headOnly })

    // Assert
    const expected = 400
    expect(response.statusCode).toEqual(expected)
  })
})
