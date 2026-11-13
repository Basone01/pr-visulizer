import type { AnalysisResult } from "@pr-visulizer/shared"
import { describe, expect, it } from "vitest"

import {
  type GatewayChangedFile,
  PR42_CONTENTS,
  PR42_FILES,
  PR42_META,
  analyzeDeepFromSources,
  analyzeFastFromSources,
} from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// A generated changed file is listed in AnalysisResult.skipped and never ranked, by either
// engine. A file whose diff is omitted stays in the review: ranked, its omission passed through.

const GENERATED_PATH = "public/build/app.min.js"
const TOO_LARGE_PATH = "src/styles/all.css"

const generatedFile: GatewayChangedFile = {
  path: GENERATED_PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  language: "javascript",
  patch: null,
}
const tooLargeFile: GatewayChangedFile = {
  path: TOO_LARGE_PATH,
  status: "modified",
  additions: 900,
  deletions: 900,
  language: null,
  patch: null,
  omissions: [{ path: TOO_LARGE_PATH, part: "diff", reason: "too-large", limitBytes: 131072 }],
}
const filesWithSkips = [...PR42_FILES, generatedFile, tooLargeFile]

function rankedPaths(result: AnalysisResult): string[] {
  return [...result.ranking].sort((a, b) => a.order - b.order).map((ranked) => ranked.path)
}

function analyzeDeep(files: GatewayChangedFile[]): Promise<AnalysisResult> {
  return analyzeDeepFromSources({
    pr: PR42_META,
    files,
    contents: new Map([...Object.entries(PR42_CONTENTS), [GENERATED_PATH, "var a=2"]]),
    grammarSource: createNodeGrammarSource(),
  })
}

function analyzeFast(files: GatewayChangedFile[]): Promise<AnalysisResult> {
  const contents = files.map((file) =>
    file.status === "deleted" ? undefined : (PR42_CONTENTS[file.path] ?? "var a=2")
  )
  return analyzeFastFromSources({
    pr: PR42_META,
    files,
    contents,
    grammarSource: createNodeGrammarSource(),
  })
}

describe("skipped changed files in the analysis", () => {
  it.each([
    ["deep", analyzeDeep],
    ["fast", analyzeFast],
  ])(
    "the %s engine never ranks a generated file, but ranks a file whose diff is omitted",
    async (_engine, analyze) => {
      // Arrange
      const withoutEither = await analyze(PR42_FILES)

      // Act
      const withBoth = await analyze(filesWithSkips)

      // Assert
      const expected = {
        ranked: [...rankedPaths(withoutEither), TOO_LARGE_PATH].sort(),
        skipped: [{ path: GENERATED_PATH, reason: "generated" }],
        omitted: tooLargeFile.omissions,
      }
      expect({
        ranked: rankedPaths(withBoth).sort(),
        skipped: withBoth.skipped,
        omitted: withBoth.omitted,
      }).toEqual(expected)
    }
  )
})
