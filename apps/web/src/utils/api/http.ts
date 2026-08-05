import type { z } from "zod"

// The one place fetch is used. Every call sites depends on this wrapper, not fetch
// directly, so the transport is swappable in one file. The network erases types —
// every response is parsed through a zod schema before it reaches the app.

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export type RawResponse = {
  status: number
  body: unknown
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return null

  return JSON.parse(text)
}

// Declared only when we ACTUALLY send JSON. Announcing a JSON body and sending none makes
// Fastify reject the request with 400 before it reaches the route — which is what a bodyless
// command POST (the PR refresh) does, and what curl never reproduces because it sends no
// content-type at all.
function jsonHeaders(init?: RequestInit): HeadersInit {
  if (init?.body === undefined) return { ...init?.headers }

  return { "content-type": "application/json", ...init.headers }
}

export async function requestJson(url: string, init?: RequestInit): Promise<RawResponse> {
  const response = await fetch(url, { ...init, headers: jsonHeaders(init) })

  return { status: response.status, body: await readBody(response) }
}

// A call whose only result is its status — a 204 with no body, where parseJson can't be used
// because there is nothing to parse. Non-2xx throws the same ApiError parseJson throws, so a
// failed command can't pass for a successful one.
export async function requestOk(url: string, init?: RequestInit): Promise<void> {
  const { status } = await requestJson(url, init)

  if (status < 200 || status >= 300) {
    throw new ApiError(status, `Request to ${url} failed with ${status}`)
  }
}

// Fetch + parse in one call: a 2xx body is validated against the schema; anything
// else throws an ApiError. Returns the parsed, typed value — never raw bytes.
export async function parseJson<Schema extends z.ZodType>(
  url: string,
  schema: Schema,
  init?: RequestInit
): Promise<z.infer<Schema>> {
  const { status, body } = await requestJson(url, init)

  if (status < 200 || status >= 300) {
    throw new ApiError(status, `Request to ${url} failed with ${status}`)
  }

  return schema.parse(body)
}
