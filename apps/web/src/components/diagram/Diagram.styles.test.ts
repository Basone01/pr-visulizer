import { describe, expect, it } from "vitest"

import stylesheet from "./Diagram.module.css?raw"

// jsdom applies no stylesheet, so this reads the rules themselves.
function dashPatternOf(selector: string): string | null {
  const start = stylesheet.indexOf(`${selector} {`)
  if (start === -1) return null

  const block = stylesheet.slice(start, stylesheet.indexOf("}", start))
  return /stroke-dasharray:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? null
}

describe("line patterns keep their meaning", () => {
  it("a reply line uses its own dash pattern, not the removed pattern or the lifeline's", () => {
    // Arrange
    const selectors = {
      reply: ".reply.edge",
      removed: ".removed .legendSwatch",
      lifeline: ".lifeline",
    }

    // Act
    const reply = dashPatternOf(selectors.reply)
    const removed = dashPatternOf(selectors.removed)
    const lifeline = dashPatternOf(selectors.lifeline)

    // Assert
    expect({
      replyIsDashed: reply !== null,
      differsFromRemoved: reply !== removed,
      differsFromLifeline: reply !== lifeline,
    }).toEqual({ replyIsDashed: true, differsFromRemoved: true, differsFromLifeline: true })
  })
})
