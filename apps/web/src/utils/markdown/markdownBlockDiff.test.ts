import { describe, expect, it } from "vitest"

import { type MarkdownBlock, diffMarkdownBlocks, splitMarkdownBlocks } from "./markdownBlockDiff"

// The rendered-markdown diff's unit is the BLOCK, not the line: a reflowed paragraph changes
// every one of its lines while saying the same thing, and a rendered view has no line numbers to
// pin a difference to anyway.

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines", () => {
    // Arrange
    const source = ["# Title", "", "First paragraph.", "", "Second paragraph."].join("\n")

    // Act
    const blocks = splitMarkdownBlocks(source)

    // Assert
    const expected = ["# Title", "First paragraph.", "Second paragraph."]
    expect(blocks).toEqual(expected)
  })

  it("keeps a fenced code block whole, blank lines and all", () => {
    // Arrange — the blank line inside the fence is CODE. Splitting there would leave two halves
    // that each re-render as something the author never wrote.
    const source = [
      "Example:",
      "",
      "```ts",
      "const a = 1",
      "",
      "const b = 2",
      "```",
      "",
      "Done.",
    ].join("\n")

    // Act
    const blocks = splitMarkdownBlocks(source)

    // Assert
    const expected = [
      "Example:",
      ["```ts", "const a = 1", "", "const b = 2", "```"].join("\n"),
      "Done.",
    ]
    expect(blocks).toEqual(expected)
  })

  it("keeps a multi-line list together as one block", () => {
    // Arrange
    const source = ["- one", "- two", "- three", "", "After."].join("\n")

    // Act
    const blocks = splitMarkdownBlocks(source)

    // Assert
    const expected = [["- one", "- two", "- three"].join("\n"), "After."]
    expect(blocks).toEqual(expected)
  })

  it("closes a fence only on a marker at least as long, of the same character", () => {
    // Arrange — a shorter run, or the other fence character, is content inside the block.
    const source = ["````md", "```", "~~~~", "````", "", "After."].join("\n")

    // Act
    const blocks = splitMarkdownBlocks(source)

    // Assert
    const expected = [["````md", "```", "~~~~", "````"].join("\n"), "After."]
    expect(blocks).toEqual(expected)
  })
})

describe("diffMarkdownBlocks", () => {
  it("marks an inserted block added and leaves its neighbours unchanged", () => {
    // Arrange
    const baseText = ["# Title", "", "Body."].join("\n")
    const headText = ["# Title", "", "New paragraph.", "", "Body."].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(baseText, headText)

    // Assert
    const expected: MarkdownBlock[] = [
      { status: "unchanged", source: "# Title" },
      { status: "added", source: "New paragraph." },
      { status: "unchanged", source: "Body." },
    ]
    expect(blocks).toEqual(expected)
  })

  it("reports a rewritten block as the removal followed by the addition", () => {
    // Arrange
    const baseText = ["# Title", "", "A small API server."].join("\n")
    const headText = ["# Title", "", "A rate-limited API server."].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(baseText, headText)

    // Assert — removal first: that is the order a reviewer reads a replacement in.
    const expected: MarkdownBlock[] = [
      { status: "unchanged", source: "# Title" },
      { status: "removed", source: "A small API server." },
      { status: "added", source: "A rate-limited API server." },
    ]
    expect(blocks).toEqual(expected)
  })

  it("marks a dropped block removed", () => {
    // Arrange
    const baseText = ["# Title", "", "Obsolete note.", "", "Body."].join("\n")
    const headText = ["# Title", "", "Body."].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(baseText, headText)

    // Assert
    const expected: MarkdownBlock[] = [
      { status: "unchanged", source: "# Title" },
      { status: "removed", source: "Obsolete note." },
      { status: "unchanged", source: "Body." },
    ]
    expect(blocks).toEqual(expected)
  })

  it("diffs a fenced block as ONE unit, not as its lines", () => {
    // Arrange — one character changes inside the fence.
    const baseFence = ["```ts", "const max = 3", "```"].join("\n")
    const headFence = ["```ts", "const max = 5", "```"].join("\n")
    const baseText = ["Config:", "", baseFence].join("\n")
    const headText = ["Config:", "", headFence].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(baseText, headText)

    // Assert
    const expected: MarkdownBlock[] = [
      { status: "unchanged", source: "Config:" },
      { status: "removed", source: baseFence },
      { status: "added", source: headFence },
    ]
    expect(blocks).toEqual(expected)
  })

  it("reports every block unchanged when the revisions are identical", () => {
    // Arrange
    const source = ["# Title", "", "Body.", "", "- a", "- b"].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(source, source)

    // Assert
    const expectedStatuses = ["unchanged", "unchanged", "unchanged"]
    expect(blocks.map((block) => block.status)).toEqual(expectedStatuses)
  })

  it("treats a file the PR added as all additions", () => {
    // Arrange
    const baseText = ""
    const headText = ["# New doc", "", "Body."].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(baseText, headText)

    // Assert
    const expected: MarkdownBlock[] = [
      { status: "added", source: "# New doc" },
      { status: "added", source: "Body." },
    ]
    expect(blocks).toEqual(expected)
  })

  it("keeps a moved block as one removal and one addition, not a cascade", () => {
    // Arrange — the intro moves below the list; everything else is untouched.
    const baseText = ["Intro.", "", "- a", "- b", "", "Outro."].join("\n")
    const headText = ["- a", "- b", "", "Intro.", "", "Outro."].join("\n")

    // Act
    const blocks = diffMarkdownBlocks(baseText, headText)

    // Assert
    const expected: MarkdownBlock[] = [
      { status: "removed", source: "Intro." },
      { status: "unchanged", source: ["- a", "- b"].join("\n") },
      { status: "added", source: "Intro." },
      { status: "unchanged", source: "Outro." },
    ]
    expect(blocks).toEqual(expected)
  })
})
