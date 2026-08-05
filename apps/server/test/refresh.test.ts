import { describe, expect, it } from "vitest"

import { buildTestApp, pollAnalysisReady } from "./helpers/buildTestApp.js"

// The refresh button's server half. The analysis job map is keyed WITHOUT a head SHA, so a PR
// that gained commits would be served its finished pre-push job forever; POST /refresh drops it
// and the next request re-enters the pipeline (which re-reads the PR at its current head).

const ANALYSIS_URL = "/api/prs/acme/web/42/analysis?engine=fast"
const REFRESH_URL = "/api/prs/acme/web/42/refresh"

describe("POST /refresh", () => {
  it("drops the finished analysis job so the next request re-runs the pipeline", async () => {
    // Arrange — a first analysis, polled to ready and therefore cached by the job map.
    const { app } = buildTestApp()
    await pollAnalysisReady(app, ANALYSIS_URL)

    // Act
    const refresh = await app.inject({ method: "POST", url: REFRESH_URL })
    const afterRefresh = await app.inject({ method: "GET", url: ANALYSIS_URL })

    // Assert — 202 again proves the cached job is gone; without the drop this would be 200.
    const expected = { refreshStatus: 204, analysisStatus: 202 }
    expect({ refreshStatus: refresh.statusCode, analysisStatus: afterRefresh.statusCode }).toEqual(
      expected
    )
  })

  it("re-runs to a ready result after the refresh", async () => {
    // Arrange
    const { app } = buildTestApp()
    await pollAnalysisReady(app, ANALYSIS_URL)
    await app.inject({ method: "POST", url: REFRESH_URL })

    // Act
    const result = await pollAnalysisReady(app, ANALYSIS_URL)

    // Assert — the re-run lands on the same PR, so the refresh is safe to press at any time.
    const expectedHeadSha = "head0042deadbeef"
    expect((result as { pr: { headSha: string } }).pr.headSha).toBe(expectedHeadSha)
  })
})
