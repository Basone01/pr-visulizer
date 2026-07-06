import type { FastifyInstance } from "fastify"
import { onTestFinished } from "vitest"

import { buildApp } from "../../src/app.js"
import { loadEnv } from "../../src/config/env.js"
import {
  type FakeGithubGateway,
  type GatewayFixture,
  createFakeGithubGateway,
} from "../../src/services/githubGateway/index.js"

// Boot the real app over the fixture-backed fake gateway (no GitHub, no network),
// with an in-memory SQLite store. Auto-closes when the test finishes. Returns the
// fake gateway so tests can assert what was forwarded to "GitHub".
export function buildTestApp(fixtures?: GatewayFixture[]): {
  app: FastifyInstance
  gateway: FakeGithubGateway
} {
  const env = loadEnv({ GITHUB_FAKE: "1", DATABASE_URL: ":memory:" })
  const gateway = fixtures ? createFakeGithubGateway(fixtures) : createFakeGithubGateway()
  const app = buildApp({ env, gateway })

  onTestFinished(async () => {
    await app.close()
  })

  return { app, gateway }
}

// Poll the analysis endpoint (202-then-poll, §9) until it returns the ready result.
export async function pollAnalysisReady(
  app: FastifyInstance,
  url: string,
  maxAttempts = 100
): Promise<unknown> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await app.inject({ method: "GET", url })
    if (response.statusCode === 200) return response.json()

    await new Promise((resolve) => setTimeout(resolve, 15))
  }

  throw new Error(`analysis at ${url} never became ready after ${maxAttempts} polls`)
}
