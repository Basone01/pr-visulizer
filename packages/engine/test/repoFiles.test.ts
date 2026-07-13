import { describe, expect, it } from "vitest"

import {
  DEFAULT_REPO_SCAN,
  createInMemoryRepoFiles,
  readRepoSources,
  scanCandidatePaths,
} from "../src/index.js"

// The RepoFiles read pass is the controllable core of deep-engine v1 (docs/architecture.md
// §6): it must keep vendored/generated code out of the index and defensively skip files it
// cannot read or that blow the size cap — never let one bad file sink the analysis.

describe("readRepoSources — ignore list", () => {
  it("skips vendored dirs and generated protobuf, keeps real source", async () => {
    // Arrange
    const repoFiles = createInMemoryRepoFiles({
      "pkg/metrics/report.go": "package metrics\n",
      "vendor/lib/thing.go": "package lib\n",
      "node_modules/dep/index.ts": "export const x = 1\n",
      "pkg/metrics/report.pb.go": "package metrics\n", // generated
      "README.md": "# docs", // not a read candidate
    })

    // Act
    const result = await readRepoSources(repoFiles, DEFAULT_REPO_SCAN)

    // Assert
    const expectedPaths = ["pkg/metrics/report.go"]
    expect([...result.contents.keys()]).toEqual(expectedPaths)
  })
})

describe("readRepoSources — defensive skips", () => {
  it("skips a file over the size cap without failing the whole scan", async () => {
    // Arrange
    const oversizedSource = `package big\n// ${"x".repeat(200)}\n`
    const repoFiles = createInMemoryRepoFiles({
      "pkg/ok.go": "package ok\n",
      "pkg/huge.go": oversizedSource,
    })
    const tinyCap = { ...DEFAULT_REPO_SCAN, maxFileBytes: 50 }

    // Act
    const result = await readRepoSources(repoFiles, tinyCap)

    // Assert
    const expected = { keptPaths: ["pkg/ok.go"], oversized: 1 }
    expect({ keptPaths: [...result.contents.keys()], oversized: result.skipped.oversized }).toEqual(
      expected
    )
  })
})

// The desktop's deep path (tauriPrClient) calls scanCandidatePaths directly to pick what to
// read out of the local git object DB, then hands the result to the worker. So this selection
// decides what buildAliasTable and the parsers ever see in the APP — a tsconfig dropped here
// means every `@/…` import resolves to nothing in the desktop, with node tests still green.
describe("scanCandidatePaths — what the desktop reads into the worker", () => {
  it("keeps every parseable source extension plus the resolution configs", () => {
    // Arrange
    const repoPaths = [
      "src/app.ts",
      "src/App.tsx",
      "src/legacy.js",
      "src/Legacy.jsx",
      "src/esm.mjs",
      "src/cjs.cjs",
      "cmd/main.go",
      "tsconfig.json",
      "go.mod",
      "web/tsconfig.json",
      "README.md",
      "logo.png",
      "node_modules/dep/index.ts",
    ]

    // Act
    const candidates = scanCandidatePaths(repoPaths, DEFAULT_REPO_SCAN)

    // Assert — docs and binaries dropped, vendored dirs dropped, configs kept.
    const expected = [
      "src/app.ts",
      "src/App.tsx",
      "src/legacy.js",
      "src/Legacy.jsx",
      "src/esm.mjs",
      "src/cjs.cjs",
      "cmd/main.go",
      "tsconfig.json",
      "go.mod",
      "web/tsconfig.json",
    ]
    expect(candidates).toEqual(expected)
  })
})
