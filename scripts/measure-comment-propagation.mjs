#!/usr/bin/env node
// How long does a review comment take to become visible on GET /pulls/:n/comments after
// POST /pulls/:n/reviews has returned? That number decides one design question in the SPA: does
// submitting a review need a retry/backoff (or an optimistic cache insert) before the comment
// can be read back, or is a plain query invalidation enough?
//
// Measured 2026-08-08 against a scratch PR: present on the FIRST poll every time — 397–446ms
// across 6 runs in two separate sessions — and that ~400ms IS the poll's own round trip, so
// GitHub's propagation lag is effectively zero. Hence `useInvalidateReviewComments` invalidates
// once and does NOT retry. Re-run this before adding any backoff, so the complexity is justified
// by a number rather than by the shape of the bug report.
//
// ⚠️  It POSTS REAL REVIEW COMMENTS to the PR you name. Point it at a scratch PR, never a review
// someone is actually reading.
//
// Usage:  node scripts/measure-comment-propagation.mjs <owner/repo> <pr-number> [runs]
//   GH_TOKEN=<token>   use this token instead of `gh auth token`
//   TIMEOUT_MS=<ms>    give up waiting for one comment (default 20000)
import { execFileSync } from "node:child_process"

const POLL_TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 20000)

function usage(message) {
  console.error(`${message}\n`)
  console.error(
    "usage: node scripts/measure-comment-propagation.mjs <owner/repo> <pr-number> [runs]"
  )
  process.exit(1)
}

const [slug, prNumberArg, runsArg] = process.argv.slice(2)
if (!slug || !slug.includes("/")) usage("missing <owner/repo>")
if (!prNumberArg) usage("missing <pr-number>")

const [owner, repo] = slug.split("/")
const prNumber = Number(prNumberArg)
const runs = Number(runsArg ?? 3)
if (!Number.isInteger(prNumber) || prNumber <= 0) usage(`bad pr number: ${prNumberArg}`)

// `gh auth token` is the default so the common case needs no setup — the same token the desktop
// app uses. An explicit GH_TOKEN wins, for CI or a different account.
function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN

  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
  } catch {
    usage("no GH_TOKEN set and `gh auth token` failed — run `gh auth login` first")
  }
}

const token = resolveToken()

function api(path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "pr-visulizer-propagation-probe",
      ...(init.headers ?? {}),
    },
  })
}

// Anchor the probe comment on a line the PR actually added, so the tool works against any PR
// instead of needing a hand-picked path and line. GitHub rejects a comment on a line outside the
// diff, which would look like a propagation failure rather than a bad anchor.
function firstAddedLine(patch) {
  let newLine = 0

  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }

    if (line.startsWith("+")) return newLine
    if (!line.startsWith("-")) newLine += 1
  }

  return null
}

async function findAnchor() {
  const response = await api(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`)
  if (!response.ok) throw new Error(`listing files failed: ${response.status}`)

  for (const file of await response.json()) {
    if (!file.patch) continue

    const line = firstAddedLine(file.patch)
    if (line !== null) return { path: file.filename, line }
  }

  throw new Error("no added line found in this PR — pick a PR that adds at least one line")
}

// Poll flat out until the marker shows up. Every attempt is recorded so "never appeared" stays
// loud instead of reading like a fast success.
async function pollUntilVisible(marker) {
  const started = performance.now()
  let polls = 0

  while (performance.now() - started < POLL_TIMEOUT_MS) {
    const response = await api(`/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`)
    const rows = await response.json()
    polls += 1

    if (Array.isArray(rows) && rows.some((row) => row.body === marker)) {
      return { visibleAfterMs: Math.round(performance.now() - started), polls }
    }
  }

  return { visibleAfterMs: null, polls }
}

const pr = await (await api(`/repos/${owner}/${repo}/pulls/${prNumber}`)).json()
if (!pr.head) usage(`cannot read ${slug}#${prNumber} — does it exist, and does the token see it?`)

const anchor = await findAnchor()
console.log(`${slug}#${prNumber} head=${pr.head.sha.slice(0, 7)}`)
console.log(`posting ${runs} real comment(s) on ${anchor.path}:${anchor.line}\n`)

const results = []

for (let run = 1; run <= runs; run += 1) {
  const marker = `propagation probe ${Date.now()}-${run}`

  const postStarted = performance.now()
  const submitResponse = await api(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: "POST",
    body: JSON.stringify({
      commit_id: pr.head.sha,
      event: "COMMENT",
      body: "",
      comments: [{ path: anchor.path, line: anchor.line, side: "RIGHT", body: marker }],
    }),
  })
  const submitMs = Math.round(performance.now() - postStarted)

  if (!submitResponse.ok) {
    console.log(`run ${run}: SUBMIT FAILED ${submitResponse.status} ${await submitResponse.text()}`)
    continue
  }

  const { visibleAfterMs, polls } = await pollUntilVisible(marker)
  results.push(visibleAfterMs)

  const verdict = visibleAfterMs === null ? `NEVER (${POLL_TIMEOUT_MS}ms)` : `${visibleAfterMs}ms`
  console.log(`run ${run}: POST ${submitMs}ms · visible after ${verdict} (${polls} poll(s))`)
}

const measured = results.filter((result) => result !== null)
if (measured.length === 0) {
  console.log("\nnothing became visible — that WOULD justify a retry/backoff in the app")
  process.exit(1)
}

// One poll means the comment was already there when we first looked: the figure is this script's
// own round trip, not a wait. That is the finding the app's design rests on.
console.log(
  `\nvisible after: min ${Math.min(...measured)}ms · max ${Math.max(...measured)}ms ` +
    `(${measured.length}/${runs} runs)`
)
console.log("a first-poll hit means GitHub had it already — no retry/backoff needed in the app")
