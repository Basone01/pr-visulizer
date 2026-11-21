import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { SymbolAnchor } from "@/entity/anchor"
import type { DiffLine as DiffLineVM } from "@/entity/diff"

import styles from "./Diff.module.css"
import stylesheet from "./Diff.module.css?raw"
import { DiffLine } from "./DiffLine"

// jsdom does no layout, so the promise is checked through the two things that produce it:
// the pill lives in the same wrapping box as the code, and that box's wrap-mode rules let the
// code claim a readable width before the pill may sit beside it.
function declarationOf(selector: string, property: string): string | null {
  const start = stylesheet.indexOf(`${selector} {`)
  if (start === -1) return null

  const block = stylesheet.slice(start, stylesheet.indexOf("}", start))
  return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? null
}

describe("DiffLine in wrap mode", () => {
  it("wrapped code keeps a readable width next to the usages pill", () => {
    // Arrange
    const lineBodyClass = styles.lineBody
    if (!lineBodyClass) throw new Error("Diff.module.css is missing the .lineBody class")

    const definitionLine: DiffLineVM = {
      kind: "add",
      content: "export const LOGIN_RATE_LIMIT: RateLimitConfig = {",
      oldLine: null,
      newLine: 8,
    }
    const definition: SymbolAnchor = {
      symbolId: "src/config/limits.ts#LOGIN_RATE_LIMIT",
      name: "LOGIN_RATE_LIMIT",
      role: "definition",
      line: 8,
      hasCounterpart: true,
      definition: null,
      usages: [
        { path: "src/lib/rateLimiter.ts", line: 4 },
        { path: "src/middleware/withRateLimit.ts", line: 9 },
        { path: "src/lib/rateLimiter.test.ts", line: 2 },
      ],
    }

    // Act
    render(
      <DiffLine
        line={definitionLine}
        tokenizer={null}
        anchors={[definition]}
        isFlash={false}
        selected={false}
        isFindCurrent={false}
        onAnchorClick={vi.fn()}
        onShowUsages={vi.fn()}
        onSelectLine={vi.fn()}
        draftsOnLine={[]}
        onEditDraft={vi.fn()}
        onDeleteDraft={vi.fn()}
      />
    )
    const pill = screen.getByRole("button", { name: "3 usages in this PR" })
    const pillBox = pill.parentElement
    const code = pillBox?.querySelector(`.${styles.content}`)
    const readableWidth = declarationOf(".diffWrap .lineBody", "--code-readable-width")

    // Assert
    const expected = {
      pillSitsInTheCodeBox: true,
      boxWrapsThePillBelowTheCode: "wrap",
      codeAsksForAReadableWidth: "1 1 min(var(--code-readable-width), 100%)",
      readableWidthIsMeasuredInCharacters: true,
    }
    expect({
      pillSitsInTheCodeBox: pillBox?.classList.contains(lineBodyClass) === true && code != null,
      boxWrapsThePillBelowTheCode: declarationOf(".diffWrap .lineBody", "flex-wrap"),
      codeAsksForAReadableWidth: declarationOf(".diffWrap .lineBody > .content", "flex"),
      readableWidthIsMeasuredInCharacters: readableWidth?.endsWith("ch") === true,
    }).toEqual(expected)
  })
})
