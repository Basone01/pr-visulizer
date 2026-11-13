import { describe, expect, it } from "vitest"

import { type PromptChangedFile, describeReviewFiles } from "./skippedFilesPrompt"

const baseSha = "778283b9"
const headSha = "3fb5c0e0"

function file(
  path: string,
  skipReason: PromptChangedFile["skipReason"] = null,
  diffOmitted: PromptChangedFile["diffOmitted"] = null
): PromptChangedFile {
  return { path, skipReason, diffOmitted }
}

describe("the review-file part of the first prompt", () => {
  it("names the generated files, folding a folder whose changed files are all generated, and shows the exclude form", () => {
    // Arrange
    const files = [
      file("application/controllers/Actions.php"),
      file("assets/build/css/summary_css.css", "generated"),
      file("assets/build/css/summary_css.css.map", "generated"),
      file("assets/css/custom.css"),
      file("assets/css/custom.css.map", "generated"),
    ]

    // Act
    const { lines } = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const expected = [
      "This PR changes 3 generated files (build output or vendored code). They need no reading. list_pr_files has the current list, each file with its skipReason:",
      "- every changed file under assets/build/ (2 files): generated",
      "- assets/css/custom.css.map: generated",
      "Leave these files out of every whole-PR git diff, git show and sem diff. Run git diff --stat 778283b9...3fb5c0e0 first, then exclude them by path, for example: git diff 778283b9...3fb5c0e0 -- . ':(exclude)assets/build' ':(exclude)assets/css/custom.css.map'",
      "sem diff --from/--to cannot leave files out, so for sem's view pipe the filtered git diff into it: git diff 778283b9...3fb5c0e0 -- . ':(exclude)assets/build' ':(exclude)assets/css/custom.css.map' | sem diff --patch -v. If that piped command is refused or fails, run the filtered git diff alone.",
    ]
    expect(lines).toEqual(expected)
  })

  it("lists a file whose diff is too large as part of the review, to be read in bounded pieces, never as needing no reading", () => {
    // Arrange
    const files = [file("src/server/router.ts", null, "too-large")]

    // Act
    const { lines } = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const expected = {
      listed: "- src/server/router.ts: diff too large to print whole",
      boundedRead: true,
      saysNoReading: false,
    }
    expect({
      listed: lines.find((line) => line.startsWith("- src/server/router.ts")),
      boundedRead: lines.some((line) => line.includes("sed -n '1,200p'")),
      saysNoReading: lines.some((line) => line.includes("need no reading")),
    }).toEqual(expected)
  })

  it("adds nothing once the analysis is in and no file is generated or diff-omitted", () => {
    // Arrange
    const files = [file("src/app.ts"), file("src/api.ts")]

    // Act
    const prompt = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const expected = { lines: [], semDiffCommand: null, gitDiffCommand: null }
    expect(prompt).toEqual(expected)
  })

  it("says while the analysis runs that diffs too large are not known yet", () => {
    // Arrange
    const files = [file("src/app.ts")]

    // Act
    const { lines } = describeReviewFiles({ files, baseSha, headSha, analysisReady: false })

    // Assert
    const expected = [
      "The analysis is still running, so files whose diff is too large are not known yet. list_pr_files lists every file with its skipReason and diffOmitted once it is done.",
    ]
    expect(lines).toEqual(expected)
  })

  it("recommends sem only on the filtered git diff while files must be left out", () => {
    // Arrange
    const files = [file("src/app.ts"), file("dist/app.min.js", "generated")]

    // Act
    const { semDiffCommand } = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const expected =
      "git diff 778283b9...3fb5c0e0 -- . ':(exclude)dist/app.min.js' | sem diff --patch -v"
    expect(semDiffCommand).toBe(expected)
  })

  it("names at most 30 generated entries and counts the rest", () => {
    // Arrange
    const generatedCount = 35
    const files = Array.from({ length: generatedCount }, (_, index) =>
      file(`dist${String(index).padStart(2, "0")}/bundle.min.js`, "generated")
    )

    // Act
    const { lines } = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const expected = { namedLines: 30, moreLine: "- and 5 more, see list_pr_files" }
    expect({
      namedLines: lines.filter((line) => line.startsWith("- dist")).length,
      moreLine: lines.find((line) => line.startsWith("- and")),
    }).toEqual(expected)
  })

  it("keeps a path from the PR on one line, with hidden characters escaped, and out of the example command", () => {
    // Arrange
    const files = [file("dist/a\nb c​d‮.min.js", "generated")]

    // Act
    const { lines } = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const expected = {
      listed: "- dist/a\\u{A}b\\u{2028}c\\u{200B}d\\u{202E}.min.js: generated",
      exampleUsesPlaceholder: true,
    }
    expect({
      listed: lines[1],
      exampleUsesPlaceholder: lines.some((line) => line.includes("':(exclude)<path>'")),
    }).toEqual(expected)
  })

  it("never puts a glob character, quote or leading dash into the example command", () => {
    // Arrange
    const files = [
      file("*/a.map", "generated"),
      file("*/b.map", "generated"),
      file("-rf/c.min.js", "generated"),
      file("it's/d.min.js", "generated"),
    ]

    // Act
    const { lines } = describeReviewFiles({ files, baseSha, headSha, analysisReady: true })

    // Assert
    const exampleLine = lines.find((line) => line.startsWith("Leave these files out")) ?? ""
    expect(exampleLine.endsWith("-- . ':(exclude)<path>'")).toBe(true)
  })
})
