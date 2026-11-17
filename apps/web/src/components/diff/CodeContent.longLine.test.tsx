import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { MAX_HIGHLIGHTED_LINE_CHARS, MAX_SHOWN_LINE_CHARS } from "@/utils/diff/longLine"

import { CodeContent } from "./CodeContent"

const copyText = vi.hoisted(() => vi.fn((_text: string) => Promise.resolve()))
vi.mock("@/utils/clipboard/copyText", () => ({ copyText }))

function plainTokenizer() {
  return vi.fn((lineText: string) => [{ content: lineText, cssVar: "var(--text)" }])
}

function renderLine(text: string, tokenizer = plainTokenizer()) {
  const view = render(
    <CodeContent text={text} tokenizer={tokenizer} anchors={[]} onAnchorClick={() => {}} />
  )
  return { ...view, tokenizer }
}

describe("CodeContent on a very long line", () => {
  it("lays out only the start of the line as plain text and says how many characters are hidden", () => {
    // Arrange
    const lineLength = 58_088
    const sourceMapLine = "A".repeat(lineLength)

    // Act
    const { container, tokenizer } = renderLine(sourceMapLine)

    // Assert
    const text = container.textContent ?? ""
    const expected = {
      highlighted: false,
      laidOutCodeChars: MAX_SHOWN_LINE_CHARS,
      note: "… 56,088 more characters not shown",
    }
    expect({
      highlighted: tokenizer.mock.calls.length > 0,
      laidOutCodeChars: text.indexOf("…"),
      note: text.slice(text.indexOf("…"), text.indexOf("Show full line")),
    }).toEqual(expected)
  })

  it("Show full line shows all of it as plain text, and the line keeps Copy line", async () => {
    // Arrange
    const lineLength = 58_088
    const sourceMapLine = "A".repeat(lineLength)
    const { container } = renderLine(sourceMapLine)

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Show full line" }))

    // Assert
    const expected = { wholeLineShown: true, copyLine: true }
    expect({
      wholeLineShown: container.textContent?.startsWith(sourceMapLine),
      copyLine: screen.queryByRole("button", { name: "Copy line" }) !== null,
    }).toEqual(expected)
  })

  it("Show less cuts a line shown in full again", async () => {
    // Arrange
    const lineLength = 58_088
    const sourceMapLine = "A".repeat(lineLength)
    const { container } = renderLine(sourceMapLine)
    await userEvent.click(screen.getByRole("button", { name: "Show full line" }))

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Show less" }))

    // Assert
    const text = container.textContent ?? ""
    expect(text.indexOf("…")).toBe(MAX_SHOWN_LINE_CHARS)
  })

  it("Copy line copies the whole line, not only the part shown", async () => {
    // Arrange
    const sourceMapLine = `${"A".repeat(3_000)}END`
    renderLine(sourceMapLine)

    // Act
    await userEvent.click(screen.getByRole("button", { name: "Copy line" }))

    // Assert
    expect(copyText).toHaveBeenCalledWith(sourceMapLine)
  })

  it("still highlights a line up to the highlight limit", () => {
    // Arrange
    const codeLine = "x".repeat(MAX_HIGHLIGHTED_LINE_CHARS)

    // Act
    const { tokenizer } = renderLine(codeLine)

    // Assert
    expect(tokenizer).toHaveBeenCalledWith(codeLine)
  })
})
