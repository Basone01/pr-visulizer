import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import "@/test/openuiJsdomPolyfills"

import OpenUiBlock, { type OpenUiBlockProps } from "./OpenUiBlock"

function program(...statements: string[]): string {
  return statements.join("\n")
}

const REVIEW_SUMMARY_BLOCK = program(
  "root = Stack([card])",
  "card = Card([header, table, warning, ref])",
  'header = CardHeader("Review summary", "PR 42")',
  "table = Table([fileCol, riskCol])",
  'fileCol = Col("File", ["src/auth.ts", "src/db.ts"])',
  'riskCol = Col("Risk", [3, 1], "number")',
  'warning = Callout("warning", "Missing guard", "The token check is skipped on refresh.")',
  'ref = FileRef("src/auth.ts", 42, "Open guard")'
)

function blockProps(overrides: Partial<OpenUiBlockProps>): OpenUiBlockProps {
  return {
    code: REVIEW_SUMMARY_BLOCK,
    streaming: false,
    canOpenFile: () => true,
    onOpenFile: vi.fn(),
    onFollowUp: vi.fn(),
    ...overrides,
  }
}

// The block renders into its own React root, and the Renderer parses in an effect,
// so let one macrotask pass before asserting.
async function renderBlock(props: OpenUiBlockProps): Promise<ReturnType<typeof render>> {
  const result = render(<OpenUiBlock {...props} />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("OpenUiBlock renders review content", () => {
  it("a valid block renders its table and its callout text", async () => {
    // Arrange
    const props = blockProps({ code: REVIEW_SUMMARY_BLOCK })

    // Act
    await renderBlock(props)

    // Assert
    const expectedCalloutTitle = "Missing guard"
    expect(screen.getByRole("table")).toHaveTextContent("src/auth.ts")
    expect(screen.getByText(expectedCalloutTitle)).toBeInTheDocument()
  })

  it("a block cut mid-stream still renders what has arrived", async () => {
    // Arrange
    const cutAt = REVIEW_SUMMARY_BLOCK.indexOf("The token check") + 5
    const partialCode = REVIEW_SUMMARY_BLOCK.slice(0, cutAt)
    const props = blockProps({ code: partialCode, streaming: true })

    // Act
    await renderBlock(props)

    // Assert
    const expectedHeader = "Review summary"
    expect(screen.getByText(expectedHeader)).toBeInTheDocument()
  })

  it("a block with an unknown component still renders the rest", async () => {
    // Arrange
    const codeWithUnknownComponent = program(
      "root = Stack([card])",
      "card = Card([header, sparkline])",
      'header = CardHeader("Known header")',
      "sparkline = Sparkline([1, 2, 3])"
    )
    const props = blockProps({ code: codeWithUnknownComponent })

    // Act
    await renderBlock(props)

    // Assert
    const expectedHeader = "Known header"
    expect(screen.getByText(expectedHeader)).toBeInTheDocument()
  })

  it("a block that cannot render at all shows its source in a fallback instead of throwing", async () => {
    // Arrange
    const unrenderableCode = "this is prose, not an openui-lang program"
    const props = blockProps({ code: unrenderableCode })

    // Act
    await renderBlock(props)

    // Assert
    const fallback = screen.getByRole("figure", { name: /Its source:/ })
    expect(fallback).toHaveTextContent(unrenderableCode)
  })
})

describe("OpenUiBlock tables fit a chat-width panel", () => {
  it("a table's text columns wrap while its number column stays on one line", async () => {
    // Arrange
    const longNote =
      "The refresh handler skips the expiry check when the token was issued by the legacy flow"
    const tableCode = program(
      "root = Stack([table])",
      `table = Table([Col("File", ["src/auth.ts"]), Col("Findings", [12345], "number"), Col("Note", ["${longNote}"])])`
    )

    // Act
    await renderBlock(blockProps({ code: tableCode }))

    // Assert
    const whiteSpaceOf = (text: string) => getComputedStyle(screen.getByText(text)).whiteSpace
    const headerWhiteSpaceOf = (text: string) =>
      getComputedStyle(screen.getByRole("columnheader", { name: text })).whiteSpace
    expect({
      fileCell: whiteSpaceOf("src/auth.ts"),
      noteCell: whiteSpaceOf(longNote),
      numberCell: whiteSpaceOf("12345"),
      noteHeader: headerWhiteSpaceOf("Note"),
      numberHeader: headerWhiteSpaceOf("Findings"),
    }).toEqual({
      fileCell: "normal",
      noteCell: "normal",
      numberCell: "nowrap",
      noteHeader: "normal",
      numberHeader: "nowrap",
    })
  })
})

describe("OpenUiBlock bar charts keep long category names whole", () => {
  // jsdom has no layout: give every element a chat-block size, so the stock chart lays its axis
  // out as it does in the app (it reads clientWidth and clientHeight).
  const blockWidth = 320
  const blockHeight = 300
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(blockWidth)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(blockHeight)
  })

  const PATHS = [
    "apps/web/src/components/openui/reviewDataComponents.tsx",
    "apps/web/src/components/openui/reviewDiagramComponents.tsx",
    "lib/common/index.ts",
    "lib/common-old/index.ts",
  ]
  const pathChart = program(
    "root = Stack([chart])",
    `chart = BarChart(${JSON.stringify(PATHS)}, [found, fixed])`,
    'found = Series("Findings", [5, 3, 8, 2])',
    'fixed = Series("Fixed", [2, 0, 1, 7])'
  )

  it("every category's full label is in the document as text", async () => {
    // Arrange
    const code = pathChart

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    const missing = PATHS.filter((path) => screen.queryByText(path) === null)
    expect(missing).toEqual([])
  })

  it("two paths that share a long prefix both show in full and look different", async () => {
    // Arrange
    const sharedPrefixPaths = [PATHS[0] ?? "", PATHS[1] ?? ""]

    // Act
    await renderBlock(blockProps({ code: pathChart }))

    // Assert
    const shown = sharedPrefixPaths.map((path) => screen.getByText(path).textContent)
    expect({ shown, distinct: new Set(shown).size }).toEqual({
      shown: sharedPrefixPaths,
      distinct: 2,
    })
  })

  it("prints each value with its series name", async () => {
    // Arrange
    const expectedValues = ["Findings 5", "Fixed 2", "Findings 2", "Fixed 7"]

    // Act
    await renderBlock(blockProps({ code: pathChart }))

    // Assert
    const missing = expectedValues.filter((value) => screen.queryByText(value) === null)
    expect(missing).toEqual([])
  })

  it("shows the axis labels as one caption line", async () => {
    // Arrange
    const code = program(
      "root = Stack([chart])",
      `chart = BarChart(${JSON.stringify(PATHS)}, [found], null, "File", "Findings")`,
      'found = Series("Findings", [5, 3, 8, 2])'
    )

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    const expected = "Findings by File"
    expect(screen.getByText(expected).tagName).toBe("FIGCAPTION")
  })

  it("a chart with short category names still uses the vertical chart", async () => {
    // Arrange
    const code = program(
      "root = Stack([chart])",
      'chart = BarChart(["auth", "db", "api"], [found])',
      'found = Series("Findings", [5, 3, 8])'
    )

    // Act
    const { container } = await renderBlock(blockProps({ code }))

    // Assert
    expect({
      verticalChart: container.ownerDocument.querySelector("[class*=bar-chart]") !== null,
      horizontalRows: screen.queryByRole("list", { name: "Bar chart rows" }),
    }).toEqual({ verticalChart: true, horizontalRows: null })
  })
})

describe("OpenUiBlock says when part of a block was left out", () => {
  it("a misspelled component is named in a short note instead of vanishing", async () => {
    // Arrange
    const code = program(
      "root = Stack([d, t])",
      'd = Diagramm("Queue", [a], [])',
      'a = DiagramNode("a", "API")',
      't = TextContent("after")'
    )

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    const expected = "Part of this block could not be shown: Diagramm is not a known component."
    expect(screen.getByRole("note").textContent).toBe(expected)
  })

  it("a misspelled component in a block with no root is named in the note, a built-in action never", async () => {
    // Arrange
    const code = program(
      'a = Diagram("Queue", [n], [])',
      'n = DiagramNode("n", "API")',
      'b = Diagramm("Typo", [], [])',
      'ask = @ToAssistant("Explain the queue")'
    )

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    const expected = "Part of this block could not be shown: Diagramm is not a known component."
    expect(screen.getByRole("note").textContent).toBe(expected)
  })

  it("a block still streaming shows no such note", async () => {
    // Arrange
    const code = program("root = Stack([d])", 'd = Diagramm("Queue", [], [])')

    // Act
    await renderBlock(blockProps({ code, streaming: true }))

    // Assert
    expect(screen.queryByRole("note")).toBeNull()
  })
})

describe("OpenUiBlock copes with a program split across blocks", () => {
  const SECOND_DIAGRAM = program(
    'd2 = Diagram("Second diagram", [api_node], [])',
    'api_node = DiagramNode("api", "Orders API", "added")'
  )

  it("a closed block with no root still draws its diagram", async () => {
    // Arrange
    const code = SECOND_DIAGRAM

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    expect({
      diagramTitle: screen.queryByText("Second diagram")?.tagName,
      fallback: screen.queryByRole("figure", { name: /Its source:/ }),
    }).toEqual({ diagramTitle: "FIGCAPTION", fallback: null })
  })

  it("a block whose root names something undefined draws the rest and says which name is missing", async () => {
    // Arrange
    const code = program(
      "root = Stack([d1, d2])",
      'd1 = Diagram("First diagram", [a], [])',
      'a = DiagramNode("a", "API")'
    )

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    expect({
      drawn: screen.queryByText("First diagram")?.tagName,
      note: screen.getByRole("note").textContent,
    }).toEqual({
      drawn: "FIGCAPTION",
      note: "Part of this block could not be shown: d2 is not defined in this block.",
    })
  })

  it("a block with a root but nothing to draw shows the fallback, not a blank", async () => {
    // Arrange
    const code = "root = Stack([d1, d2])"

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    const expected = "Nothing in this block could be drawn. Its source:"
    expect(screen.getByText(expected).tagName).toBe("FIGCAPTION")
  })

  it("an empty block says it is empty, with no empty source box", async () => {
    // Arrange
    const code = "  \n"

    // Act
    const { container } = await renderBlock(blockProps({ code }))

    // Assert
    expect({
      message: screen.queryByText("This block is empty.") !== null,
      sourceBoxes: container.ownerDocument.querySelectorAll("pre").length,
    }).toEqual({ message: true, sourceBoxes: 0 })
  })

  it("a rootless block of parts that only draw inside a diagram shows the fallback, never a blank box", async () => {
    // Arrange
    const code = program(
      'n3 = DiagramNode("cache", "Cache", "added")',
      'e3 = DiagramEdge("api", "cache", "read", "added")'
    )

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    const expected = "This block has no root statement and nothing to build one from. Its source:"
    expect(screen.getByText(expected).tagName).toBe("FIGCAPTION")
  })

  it("a fallback still names what was left out", async () => {
    // Arrange
    const code = "root = Stack([summary])"

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    expect({
      fallback: screen.queryByRole("figure", { name: /Its source:/ }) !== null,
      note: screen.getByRole("note").textContent,
    }).toEqual({
      fallback: true,
      note: "Part of this block could not be shown: summary is not defined in this block.",
    })
  })

  it("a root statement that could not be built is not called missing", async () => {
    // Arrange
    const code = program("root = Stak([c])", 'c = Callout("info", "Heads up", "text")')

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    expect({
      caption: screen.queryByText("This block's root could not be built. Its source:")?.tagName,
      note: screen.getByRole("note").textContent,
    }).toEqual({
      caption: "FIGCAPTION",
      note: "Part of this block could not be shown: Stak is not a known component.",
    })
  })

  it.each([
    ["a Stack that holds only text", 'root = Stack(["just text"])', "just text"],
    [
      "a root that is itself a Callout",
      'root = Callout("info", "Heads up", "callout body")',
      "Heads up",
    ],
  ])("a valid block is never failed: %s", async (_case, code, shownText) => {
    // Arrange
    const props = blockProps({ code })

    // Act
    await renderBlock(props)

    // Assert
    expect({
      shown: screen.queryAllByText(shownText).length > 0,
      fallback: screen.queryByRole("figure", { name: /Its source:/ }),
    }).toEqual({ shown: true, fallback: null })
  })

  it("a part defined twice in a rootless block is drawn once", async () => {
    // Arrange
    const code = program(
      'a = Callout("info", "First", "one")',
      'a = Callout("info", "Second", "two")'
    )

    // Act
    await renderBlock(blockProps({ code }))

    // Assert
    expect(screen.getAllByText("two")).toHaveLength(1)
  })

  it("a rootless block is not given a root while it is still streaming", async () => {
    // Arrange
    const code = SECOND_DIAGRAM

    // Act
    await renderBlock(blockProps({ code, streaming: true }))

    // Assert
    expect(screen.queryByText("Second diagram")).toBeNull()
  })
})

describe("OpenUiBlock reports clicks to the host", () => {
  it("a file reference the host can open is a button that reports its path and line", async () => {
    // Arrange
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    await renderBlock(blockProps({ onOpenFile }))

    // Act
    await user.click(screen.getByRole("button", { name: "Open guard" }))

    // Assert
    const expectedPath = "src/auth.ts"
    const expectedLine = 42
    expect(onOpenFile).toHaveBeenCalledWith(expectedPath, expectedLine)
  })

  it("a follow-up button reports its message", async () => {
    // Arrange
    const user = userEvent.setup()
    const onFollowUp = vi.fn()
    const followUpCode = program(
      "root = Stack([buttons])",
      "buttons = Buttons([explain])",
      'explain = Button("Explain auth", @ToAssistant("Explain the auth change"))'
    )
    await renderBlock(blockProps({ code: followUpCode, onFollowUp }))

    // Act
    await user.click(screen.getByRole("button", { name: "Explain auth" }))

    // Assert
    const expectedMessage = "Explain the auth change"
    expect(onFollowUp).toHaveBeenCalledWith(expectedMessage)
  })
})

describe("OpenUiBlock file references follow what the host can open", () => {
  it("a file reference to a file the host cannot open is plain text and opens nothing", async () => {
    // Arrange
    const onOpenFile = vi.fn()
    const canOpenFile = () => false
    const foreignFileCode = program(
      "root = Stack([card])",
      "card = Card([ref])",
      'ref = FileRef("docs/other.md", 3, "Other doc")'
    )

    // Act
    await renderBlock(blockProps({ code: foreignFileCode, canOpenFile, onOpenFile }))

    // Assert
    const expectedText = "Other doc (docs/other.md:3)"
    expect({
      button: screen.queryByRole("button", { name: /Other doc/ }),
      textShown: screen.getByText(expectedText).tagName,
      opened: onOpenFile.mock.calls,
    }).toEqual({ button: null, textShown: "SPAN", opened: [] })
  })

  it("a file reference path is normalized the same way for the check and the click", async () => {
    // Arrange
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    const prFilePath = "src/auth.ts"
    const canOpenFile = vi.fn((path: string) => path === prFilePath)
    const dotSlashCode = program(
      "root = Stack([card])",
      "card = Card([ref])",
      'ref = FileRef("./src/auth.ts", 42, "Open guard")'
    )
    await renderBlock(blockProps({ code: dotSlashCode, canOpenFile, onOpenFile }))

    // Act
    await user.click(screen.getByRole("button", { name: "Open guard" }))

    // Assert
    const line = 42
    expect({
      checked: canOpenFile.mock.calls.map(([path]) => path),
      opened: onOpenFile.mock.calls,
    }).toEqual({
      checked: expect.arrayContaining([prFilePath]),
      opened: [[prFilePath, line]],
    })
  })
})

describe("OpenUiBlock list items", () => {
  it("a clickable list item reports its follow-up message", async () => {
    // Arrange
    const user = userEvent.setup()
    const onFollowUp = vi.fn()
    const listCode = program(
      "root = Stack([list])",
      "list = ListBlock([first])",
      'first = ListItem("Check the auth guard", "src/auth.ts", "Ask", @ToAssistant("Why is the auth guard risky?"))'
    )
    await renderBlock(blockProps({ code: listCode, onFollowUp }))

    // Act
    await user.click(screen.getByRole("button", { name: /Check the auth guard/ }))

    // Assert
    const expectedMessage = "Why is the auth guard risky?"
    expect(onFollowUp).toHaveBeenCalledWith(expectedMessage)
  })
})

describe("OpenUiBlock list item actions", () => {
  it("a list item action works from the keyboard with Enter and Space", async () => {
    // Arrange
    const user = userEvent.setup()
    const onFollowUp = vi.fn()
    const listCode = program(
      "root = Stack([list])",
      "list = ListBlock([first])",
      'first = ListItem("Check the auth guard", "src/auth.ts", "Ask", @ToAssistant("Why is the auth guard risky?"))'
    )
    await renderBlock(blockProps({ code: listCode, onFollowUp }))
    screen.getByRole("button", { name: /Check the auth guard/ }).focus()

    // Act
    await user.keyboard("{Enter}")
    await user.keyboard(" ")

    // Assert
    const expectedMessage = "Why is the auth guard risky?"
    expect(onFollowUp.mock.calls).toEqual([[expectedMessage], [expectedMessage]])
  })

  it("a list item action does nothing while its block is still streaming", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const streamingListCode = program(
      "root = Stack([list])",
      "list = ListBlock([item])",
      'item = ListItem("TS", "Docs", "Open", @OpenUrl("https://docs.github.co"))'
    )
    await renderBlock(blockProps({ code: streamingListCode, streaming: true }))
    const itemAction = screen.getByRole("button", { name: /TS/ })

    // Act
    await user.click(itemAction)

    // Assert
    expect({
      disabled: itemAction.hasAttribute("disabled"),
      opened: openWindow.mock.calls,
    }).toEqual({ disabled: true, opened: [] })
  })
})

describe("OpenUiBlock never lets a model-chosen URL load in the webview", () => {
  const linkButtonsCode = program(
    "root = Stack([buttons])",
    "buttons = Buttons([docs, plain, script])",
    'docs = Button("Docs", @OpenUrl("https://example.com/docs"))',
    'plain = Button("Plain http", @OpenUrl("http://example.com/docs"))',
    'script = Button("Script", @OpenUrl("javascript:alert(1)"))'
  )

  it("an https link action opens through the app's external-URL util", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    await renderBlock(blockProps({ code: linkButtonsCode }))

    // Act
    await user.click(screen.getByRole("button", { name: "Docs (example.com)" }))

    // Assert
    const expectedUrl = "https://example.com/docs"
    expect(openWindow).toHaveBeenCalledWith(expectedUrl, "_blank", "noopener,noreferrer")
  })

  it("a link action with any other scheme is ignored", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    await renderBlock(blockProps({ code: linkButtonsCode }))

    // Act
    await user.click(screen.getByRole("button", { name: "Plain http" }))
    await user.click(screen.getByRole("button", { name: "Script" }))

    // Assert
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("a markdown image inside a block never becomes an img element", async () => {
    // Arrange
    const imageMarkdownCode = program(
      "root = Stack([card])",
      "card = Card([text, note])",
      'text = TextContent("Before ![tracker](https://tracker.example/pixel.png) after")',
      'note = Callout("info", "Note", "See ![x](https://tracker.example/x.png)")'
    )
    const props = blockProps({ code: imageMarkdownCode })

    // Act
    const { container } = await renderBlock(props)

    // Assert
    expect(container.querySelector("img")).toBeNull()
  })

  it("a markdown link inside a block opens https through the app util, never by navigating", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const linkMarkdownCode = program(
      "root = Stack([text])",
      'text = TextContent("Read [the guide](https://example.com/guide).")'
    )
    await renderBlock(blockProps({ code: linkMarkdownCode }))

    // Act
    await user.click(screen.getByRole("button", { name: "the guide (example.com)" }))

    // Assert
    const expectedUrl = "https://example.com/guide"
    expect(openWindow).toHaveBeenCalledWith(expectedUrl, "_blank", "noopener,noreferrer")
  })

  it("one click on a button with many @OpenUrl steps opens only the first URL", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const manyUrlsCode = program(
      "root = Stack([buttons])",
      "buttons = Buttons([burst])",
      'burst = Button("Read more", Action([@OpenUrl("https://a.example/1"), @OpenUrl("https://b.example/2"), @OpenUrl("https://c.example/3")]))'
    )
    await renderBlock(blockProps({ code: manyUrlsCode }))

    // Act
    await user.click(screen.getByRole("button", { name: "Read more (a.example)" }))

    // Assert
    const expectedCalls = [["https://a.example/1", "_blank", "noopener,noreferrer"]]
    expect(openWindow.mock.calls).toEqual(expectedCalls)
  })

  it("a link that leaves the app shows its target host before the click", async () => {
    // Arrange
    const disguisedLinkCode = program(
      "root = Stack([text, buttons])",
      'text = TextContent("See [src/auth.ts:42](https://elsewhere.example/x).")',
      "buttons = Buttons([docs])",
      'docs = Button("Docs", @OpenUrl("https://docs.example/guide"))'
    )

    // Act
    await renderBlock(blockProps({ code: disguisedLinkCode }))

    // Assert
    const expectedNames = ["src/auth.ts:42 (elsewhere.example)", "Docs (docs.example)"]
    const linkNames = expectedNames.map(
      (name) => screen.queryByRole("button", { name })?.textContent
    )
    expect(linkNames).toEqual(expectedNames)
  })

  it("an open-url action written as an object literal shows its target host and opens only that URL", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const literalActionCode = program(
      "root = Stack([buttons])",
      "buttons = Buttons([literal])",
      'literal = Button("LitA", {type: "open_url", params: {url: "https://hidden.example/a"}})'
    )
    await renderBlock(blockProps({ code: literalActionCode }))

    // Act
    await user.click(screen.getByRole("button", { name: "LitA (hidden.example)" }))

    // Assert
    const expectedCalls = [["https://hidden.example/a", "_blank", "noopener,noreferrer"]]
    expect(openWindow.mock.calls).toEqual(expectedCalls)
  })

  it("a list item with an object-literal open-url action shows its target host", async () => {
    // Arrange
    const listCode = program(
      "root = Stack([list])",
      "list = ListBlock([item])",
      'item = ListItem("src/auth.ts:42", "Open the guard", "Open file", {type: "open_url", params: {url: "https://hidden.example/l"}})'
    )

    // Act
    await renderBlock(blockProps({ code: listCode }))

    // Assert
    expect(screen.getByRole("button", { name: /src\/auth\.ts:42/ })).toHaveTextContent(
      "(hidden.example)"
    )
  })

  it("a bidi control in a label cannot reorder the target host, and the button carries the full URL", async () => {
    // Arrange
    const rightToLeftOverride = "\u202E"
    const bidiLabelCode = program(
      "root = Stack([buttons])",
      "buttons = Buttons([spoof])",
      `spoof = Button("Open ${rightToLeftOverride}", @OpenUrl("https://moc.buhtig.it/x"))`
    )

    // Act
    await renderBlock(blockProps({ code: bidiLabelCode }))

    // Assert
    const button = screen.getByRole("button", { name: /moc\.buhtig\.it/ })
    const hostElement = button.querySelector("bdi")
    expect({
      labelHasBidiControl: button.textContent?.includes(rightToLeftOverride),
      hostTag: hostElement?.tagName,
      hostDirection: hostElement?.getAttribute("dir"),
      hostText: hostElement?.textContent,
      title: button.getAttribute("title"),
    }).toEqual({
      labelHasBidiControl: false,
      hostTag: "BDI",
      hostDirection: "ltr",
      hostText: "(moc.buhtig.it)",
      title: "https://moc.buhtig.it/x",
    })
  })

  it("a URL with userinfo shows the host it really goes to, not the userinfo", async () => {
    // Arrange
    const userinfoCode = program(
      "root = Stack([text, buttons])",
      'text = TextContent("See [github docs](https://github.com@evil.example/x).")',
      "buttons = Buttons([docs])",
      'docs = Button("Docs", @OpenUrl("https://github.com@evil.example/y"))'
    )

    // Act
    await renderBlock(blockProps({ code: userinfoCode }))

    // Assert
    const expectedNames = ["github docs (evil.example)", "Docs (evil.example)"]
    const names = expectedNames.map((name) => screen.queryByRole("button", { name })?.textContent)
    expect(names).toEqual(expectedNames)
  })

  it("an action with a null steps key shows no host and opens nothing, as OpenUI turns it into a follow-up", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const onFollowUp = vi.fn()
    const nullStepsCode = program(
      "root = Stack([buttons])",
      "buttons = Buttons([x])",
      'x = Button("X", {type: "open_url", url: "https://a.example/", steps: null})'
    )
    await renderBlock(blockProps({ code: nullStepsCode, onFollowUp }))

    // Act
    await user.click(screen.getByRole("button", { name: "X" }))

    // Assert
    expect({ opened: openWindow.mock.calls, followUps: onFollowUp.mock.calls }).toEqual({
      opened: [],
      followUps: [["X"]],
    })
  })

  it("an action whose steps is an object shows no host, opens nothing and its failure is caught", async () => {
    // Arrange
    const user = userEvent.setup()
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const logError = vi.spyOn(console, "error").mockImplementation(() => {})
    const objectStepsCode = program(
      "root = Stack([buttons])",
      "buttons = Buttons([y])",
      'y = Button("Y", {type: "open_url", url: "https://a.example/", steps: {a: 1}})'
    )
    await renderBlock(blockProps({ code: objectStepsCode }))

    // Act
    await user.click(screen.getByRole("button", { name: "Y" }))
    await act(async () => {})

    // Assert
    const caughtFailures = logError.mock.calls.filter(
      ([message]) => message === "Block action failed:"
    )
    expect({ opened: openWindow.mock.calls, caught: caughtFailures.length }).toEqual({
      opened: [],
      caught: 1,
    })
  })

  it("a bidi control nested in markdown link text is stripped", async () => {
    // Arrange
    const rightToLeftOverride = "\u202E"
    const nestedLinkCode = program(
      "root = Stack([text])",
      `text = TextContent("See [**${rightToLeftOverride}(moc.buhtig)** and \`${rightToLeftOverride}x\`](https://evil.example/m).")`
    )

    // Act
    await renderBlock(blockProps({ code: nestedLinkCode }))

    // Assert
    const link = screen.getByRole("button", { name: /evil\.example/ })
    expect(link.textContent?.includes(rightToLeftOverride)).toBe(false)
  })

  it("a FileRef's title has no bidi controls", async () => {
    // Arrange
    const rightToLeftOverride = "\u202E"
    const fileRefCode = program(
      "root = Stack([card])",
      "card = Card([ref])",
      `ref = FileRef("src/a${rightToLeftOverride}.ts", 3, "Open a")`
    )

    // Act
    await renderBlock(blockProps({ code: fileRefCode }))

    // Assert
    const expectedTitle = "src/a.ts:3"
    expect(screen.getByRole("button", { name: "Open a" })).toHaveAttribute("title", expectedTitle)
  })
})
