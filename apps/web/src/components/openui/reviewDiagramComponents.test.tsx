import { Renderer } from "@openuidev/react-lang"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import ELK from "elkjs/lib/elk.bundled.js"
import { describe, expect, it, vi } from "vitest"

import type { ElkRunner } from "@/utils/diagram/layeredLayout"

import diagramStyles from "@/components/diagram/Diagram.module.css"
import { DiagramLayoutContext } from "@/components/diagram/diagramLayoutContext"

import "@/test/openuiJsdomPolyfills"

import { type BlockHost, BlockHostContext } from "./blockHost"
import { reviewLibrary } from "./reviewLibrary"

// The OpenUI wrappers, driven by real OpenUI Lang through the review library. Rendered without
// OpenUiBlock's own React root so the test can provide elk in-process through context.
const runElkInProcess: ElkRunner = (graph) => new ELK().layout(graph)

function renderProgram(program: string, host: Partial<BlockHost>) {
  const fullHost: BlockHost = {
    canOpenFile: () => true,
    openFile: vi.fn(),
    openShownLink: vi.fn(),
    armActionLink: vi.fn(),
    ...host,
  }

  return render(
    <DiagramLayoutContext.Provider value={runElkInProcess}>
      <BlockHostContext.Provider value={fullHost}>
        <Renderer response={program} library={reviewLibrary} isStreaming={false} />
      </BlockHostContext.Provider>
    </DiagramLayoutContext.Provider>
  )
}

const DIAGRAM_PROGRAM = [
  "root = Stack([d])",
  'd = Diagram("Order dispatch moves to a queue", [api, queue, mail], [e1, e2], [backend])',
  'api = DiagramNode("api", "Orders API", "changed", "direct send → enqueue", "./src/api/orders.ts")',
  'queue = DiagramNode("queue", "Job queue", "added", null, null, "store")',
  'mail = DiagramNode("mail", "Mailer", "removed", "replaced by the worker")',
  'e1 = DiagramEdge("api", "queue", "enqueue", "added")',
  'e2 = DiagramEdge("api", "mail", "send", "removed")',
  'backend = DiagramGroup("Backend", ["api", "queue"])',
].join("\n")

describe("Diagram blocks written in OpenUI Lang", () => {
  it("a diagram program draws its nodes, skipping optional arguments with null", async () => {
    // Arrange
    const program = DIAGRAM_PROGRAM

    // Act
    renderProgram(program, {})
    const picture = await screen.findByRole("group", { name: /Order dispatch moves to a queue/ })

    // Assert
    expect({
      edges: picture.querySelectorAll("path[marker-end]").length,
      storeTag: picture.textContent?.includes("STORE"),
      groupEyebrow: picture.textContent?.includes("BACKEND"),
    }).toEqual({ edges: 2, storeTag: true, groupEyebrow: true })
  })

  it("a node's file opens with the same path normalization as FileRef", async () => {
    // Arrange
    const user = userEvent.setup()
    const openFile = vi.fn()
    const canOpenFile = vi.fn((path: string) => path === "src/api/orders.ts")
    renderProgram(DIAGRAM_PROGRAM, { canOpenFile, openFile })
    await screen.findByRole("group", { name: /Order dispatch/ })

    // Act
    await user.click(screen.getByRole("button", { name: "Orders API, open ./src/api/orders.ts" }))

    // Assert
    expect(openFile.mock.calls).toEqual([["src/api/orders.ts", undefined]])
  })

  it("a sequence program draws its participants and messages in order", () => {
    // Arrange
    const program = [
      "root = Stack([s])",
      's = SequenceDiagram("Checkout", [ui, api], [m1, m2])',
      'ui = SequenceParticipant("ui", "Checkout UI")',
      'api = SequenceParticipant("api", "Orders API", "changed")',
      'm1 = SequenceMessage("ui", "api", "POST /orders")',
      'm2 = SequenceMessage("api", "ui", "202 Accepted", "changed", true)',
    ].join("\n")

    // Act
    renderProgram(program, {})

    // Assert
    const picture = screen.getByRole("img", { name: /Checkout/ })
    expect({
      arrows: picture.querySelectorAll("path[marker-end]").length,
      text: ["Checkout UI", "Orders API", "POST /orders", "202 Accepted"].every((text) =>
        picture.textContent?.includes(text)
      ),
    }).toEqual({ arrows: 2, text: true })
  })
})

describe("agent mistakes reach the diagram's tolerance rules instead of dropping objects", () => {
  it("a node with a null label keeps its status and note, named by its id", async () => {
    // Arrange
    const program = [
      "root = Stack([d])",
      'd = Diagram("Store", [a, b], [e])',
      'a = DiagramNode("a", "API")',
      'b = DiagramNode("b", null, "added", "new store")',
      'e = DiagramEdge("a", "b")',
    ].join("\n")

    // Act
    renderProgram(program, {})
    await screen.findByRole("img", { name: /Store/ })

    // Assert
    const ledger = screen.getByRole("region", { name: "Changes" })
    expect(ledger.textContent).toContain("ADDEDbnew store")
  })

  it("a capitalised change value still marks the node", async () => {
    // Arrange
    const program = [
      "root = Stack([d])",
      'd = Diagram("Caps", [a], [])',
      'a = DiagramNode("a", "API", "Added", "new thing")',
    ].join("\n")

    // Act
    renderProgram(program, {})
    await screen.findByRole("img", { name: /Caps/ })

    // Assert
    const ledger = screen.getByRole("region", { name: "Changes" })
    expect(ledger.textContent).toContain("ADDEDAPInew thing")
  })

  it("a node with a numeric id is drawn", async () => {
    // Arrange
    const program = [
      "root = Stack([d])",
      'd = Diagram("Numbers", [a], [])',
      'a = DiagramNode(1, "One", "added")',
    ].join("\n")

    // Act
    renderProgram(program, {})
    const picture = await screen.findByRole("img", { name: /Numbers/ })

    // Assert
    expect(picture.textContent).toContain("One")
  })

  it("a diagram with a null title is still drawn, under a default title", async () => {
    // Arrange
    const program = [
      "root = Stack([d, t])",
      "d = Diagram(null, [a], [])",
      'a = DiagramNode("a", "API")',
      't = TextContent("after")',
    ].join("\n")

    // Act
    renderProgram(program, {})
    const picture = await screen.findByRole("img", { name: /Diagram/ })

    // Assert
    expect(picture.textContent).toContain("API")
  })

  it("a sequence message with a null label is still drawn", () => {
    // Arrange
    const program = [
      "root = Stack([s])",
      's = SequenceDiagram("Flow", [p, q], [m1, m2])',
      'p = SequenceParticipant("p", "Client")',
      'q = SequenceParticipant("q", "Server")',
      'm1 = SequenceMessage("p", "q", "request")',
      'm2 = SequenceMessage("q", "p", null, null, true)',
    ].join("\n")

    // Act
    renderProgram(program, {})

    // Assert
    const picture = screen.getByRole("img", { name: /Flow/ })
    expect(picture.querySelectorAll("path[marker-end]").length).toBe(2)
  })

  it("a node whose path is written as a FileRef opens that file", async () => {
    // Arrange
    const user = userEvent.setup()
    const openFile = vi.fn()
    const program = [
      "root = Stack([d])",
      'd = Diagram("Refs", [a], [])',
      'a = DiagramNode("a", "Orders API", "changed", null, FileRef("src/api/orders.ts"))',
    ].join("\n")
    renderProgram(program, { openFile })
    await screen.findByRole("group", { name: /Refs/ })

    // Act
    await user.click(screen.getByRole("button", { name: "Orders API, open src/api/orders.ts" }))

    // Assert
    expect(openFile.mock.calls).toEqual([["src/api/orders.ts", undefined]])
  })
})

describe("a small slip in a diagram program never drops the whole diagram", () => {
  it("a diagram with its edges left out is still drawn", async () => {
    // Arrange
    const program = [
      "root = Stack([d])",
      'd = Diagram("No edges", [a])',
      'a = DiagramNode("a", "API")',
    ].join("\n")

    // Act
    renderProgram(program, {})
    const picture = await screen.findByRole("img", { name: /No edges/ })

    // Assert
    expect(picture.textContent).toContain("API")
  })

  it("a single node not wrapped in a list is still drawn", async () => {
    // Arrange
    const program = [
      "root = Stack([d])",
      'd = Diagram("Single", a, [])',
      'a = DiagramNode("a", "API")',
    ].join("\n")

    // Act
    renderProgram(program, {})
    const picture = await screen.findByRole("img", { name: /Single/ })

    // Assert
    expect(picture.textContent).toContain("API")
  })

  it("a sequence with its messages left out is still drawn", () => {
    // Arrange
    const program = [
      "root = Stack([s])",
      's = SequenceDiagram("Alone", [p])',
      'p = SequenceParticipant("p", "Client")',
    ].join("\n")

    // Act
    renderProgram(program, {})

    // Assert
    const picture = screen.getByRole("img", { name: /Alone/ })
    expect(picture.textContent).toContain("Client")
  })
})

describe("values the readers accept are not lost in the schema", () => {
  it("a numeric label, a boolean id, a string reply and a group of node references all survive", async () => {
    // Arrange
    const flow = [
      "root = Stack([d, s])",
      'd = Diagram("Values", [a, b], [e], [g])',
      'a = DiagramNode("a", 42, "added")',
      'b = DiagramNode(true, "Flag", "added")',
      'e = DiagramEdge("a", "true")',
      'g = DiagramGroup("Zone", [a])',
      's = SequenceDiagram("Reply", [p, q], [m])',
      'p = SequenceParticipant("p", "Client")',
      'q = SequenceParticipant("q", "Server")',
      'm = SequenceMessage("q", "p", "ok", null, "true")',
    ].join("\n")

    // Act
    renderProgram(flow, {})
    const picture = await screen.findByRole("img", { name: /Values/ })

    // Assert
    const sequence = screen.getByRole("img", { name: /Reply/ })
    const replyClass = diagramStyles["reply"] ?? "reply"
    expect({
      numericLabel: picture.textContent?.includes("42"),
      booleanIdNode: picture.textContent?.includes("Flag"),
      groupKept: picture.textContent?.includes("ZONE"),
      replyDrawnAsReply: sequence.querySelector(`path.${replyClass}`) !== null,
    }).toEqual({
      numericLabel: true,
      booleanIdNode: true,
      groupKept: true,
      replyDrawnAsReply: true,
    })
  })
})

describe("a node's FileRef path keeps its line", () => {
  it("opens the file at the FileRef's line from the node and from its ledger link", async () => {
    // Arrange
    const user = userEvent.setup()
    const openFile = vi.fn()
    const program = [
      "root = Stack([d])",
      'd = Diagram("Lines", [a], [])',
      'a = DiagramNode("a", "Orders API", "changed", "moved", FileRef("src/api/orders.ts", 42))',
    ].join("\n")
    renderProgram(program, { openFile })
    await screen.findByRole("group", { name: /Lines/ })

    // Act
    await user.click(screen.getByRole("button", { name: "Orders API, open src/api/orders.ts" }))
    await user.click(screen.getByRole("button", { name: "src/api/orders.ts" }))

    // Assert
    const expected = [
      ["src/api/orders.ts", 42],
      ["src/api/orders.ts", 42],
    ]
    expect(openFile.mock.calls).toEqual(expected)
  })
})
