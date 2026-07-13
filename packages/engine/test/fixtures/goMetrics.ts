import type { PrMeta } from "@pr-visulizer/shared"

import type { GatewayChangedFile, GatewayFixture } from "../../src/index.js"

// The motivating deep-engine case (docs/architecture.md §6): a Go PR that only ADDS a
// field to a struct — no call edges anywhere. Fast mode reads only the changed files and
// per-file imports, so it can NEVER see who references the `Report` type, because Go
// same-package references carry no import and no qualifier. Deep mode indexes the whole
// repo and must surface every referrer, changed and unchanged.
//
// Package `metrics` lives in `pkg/metrics/` (types.go, aggregate.go, report_builder.go);
// package `api` in `pkg/api/` imports it. Module path is declared in go.mod.

export const GO_MODULE_PATH = "example.com/proj"

export const GO_METRICS_PATHS = {
  goMod: "go.mod",
  types: "pkg/metrics/types.go", // CHANGED — Report gains a field
  aggregate: "pkg/metrics/aggregate.go", // UNCHANGED — uses Report unqualified (same package)
  builder: "pkg/metrics/report_builder.go", // CHANGED — uses Report unqualified (same package)
  handler: "pkg/api/handler.go", // UNCHANGED — imports the module + uses metrics.Report
} as const

export const GO_REPORT_ID = `${GO_METRICS_PATHS.types}#Report`
export const GO_BUILD_ID = `${GO_METRICS_PATHS.builder}#Build`

export const GO_METRICS_META: PrMeta = {
  owner: "acme",
  repo: "svc",
  number: 7,
  title: "Add Flagged to metrics.Report",
  author: "contributor-dev",
  baseSha: "base0007cafebabe",
  headSha: "head0007deadbeef",
}

const goModSource = `module ${GO_MODULE_PATH}

go 1.22
`

// Report at lines 3–7; the added field `Flagged` sits inside that span, so the head hunk
// intersects the type declaration → changeKind "modified".
const typesSource = `package metrics

type Report struct {
	Total   int
	Name    string
	Flagged bool
}
`
const typesPatch = `@@ -3,4 +3,5 @@
 type Report struct {
 	Total   int
 	Name    string
+	Flagged bool
 }
`

const aggregateSource = `package metrics

func TotalOf(r Report) int {
	return r.Total
}
`

const builderSource = `package metrics

func Build() Report {
	var out Report
	return out
}
`

const handlerSource = `package api

import "${GO_MODULE_PATH}/pkg/metrics"

func Latest() metrics.Report {
	var out metrics.Report
	return out
}
`

// The full checkout at headSha (what RepoFiles serves) — every file, changed or not.
export const GO_METRICS_REPO: Record<string, string> = {
  [GO_METRICS_PATHS.goMod]: goModSource,
  [GO_METRICS_PATHS.types]: typesSource,
  [GO_METRICS_PATHS.aggregate]: aggregateSource,
  [GO_METRICS_PATHS.builder]: builderSource,
  [GO_METRICS_PATHS.handler]: handlerSource,
}

// The changed-file list the gateway returns (only types.go + report_builder.go changed).
export const GO_METRICS_CHANGED_FILES: GatewayChangedFile[] = [
  {
    path: GO_METRICS_PATHS.types,
    status: "modified",
    additions: 1,
    deletions: 0,
    language: "go",
    patch: typesPatch,
  },
  {
    path: GO_METRICS_PATHS.builder,
    status: "added",
    additions: 5,
    deletions: 0,
    language: "go",
    patch: `@@ -0,0 +1,6 @@\n${builderSource
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}\n`,
  },
]

// A gateway fixture for the fake GithubGateway. Deep mode reads content from RepoFiles, so
// `contents` here only needs the changed files (getFileContent is never called by deep).
export function goMetricsFixture(): GatewayFixture {
  return {
    meta: GO_METRICS_META,
    files: GO_METRICS_CHANGED_FILES,
    contents: {
      [GO_METRICS_PATHS.types]: typesSource,
      [GO_METRICS_PATHS.builder]: builderSource,
    },
  }
}
