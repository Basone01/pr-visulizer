import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import ELK from "elkjs/lib/elk.bundled.js"
import { Activity, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { ElkRunner } from "@/utils/diagram/layeredLayout"

import { type RawFlowDiagram, normalizeFlowDiagram } from "@/entity/diagram/flowDiagram"
import { type RawSequenceDiagram, normalizeSequenceDiagram } from "@/entity/diagram/sequenceDiagram"

import styles from "./Diagram.module.css"
import { DiagramView } from "./DiagramView"
import { SequenceDiagramView } from "./SequenceDiagramView"
import { DiagramLayoutContext } from "./diagramLayoutContext"

// Real elk, run in the test process instead of the web worker.
const runElkInProcess: ElkRunner = (graph) => new ELK().layout(graph)
const failingRunner: ElkRunner = () => Promise.reject(new Error("elk crashed"))

function withLayout(runner: ElkRunner, children: ReactNode): ReactNode {
  return <DiagramLayoutContext.Provider value={runner}>{children}</DiagramLayoutContext.Provider>
}

const QUEUE_ROLLOUT: RawFlowDiagram = {
  title: "Order dispatch moves to a queue",
  nodes: [
    {
      id: "api",
      label: "Orders API",
      change: "changed",
      note: "direct dispatch → enqueue",
      path: "src/api/orders.ts",
    },
    { id: "queue", label: "Job queue", change: "added", kind: "store", note: "new" },
    { id: "worker", label: "Dispatch worker", change: "added", path: "src/jobs/dispatch.ts" },
    { id: "mailer", label: "Legacy mailer", change: "removed", note: "replaced by worker" },
    { id: "db", label: "Orders DB", kind: "store" },
  ],
  edges: [
    { from: "api", to: "queue", label: "enqueue", change: "added" },
    { from: "queue", to: "worker", label: "consume", change: "added" },
    { from: "api", to: "mailer", label: "send", change: "removed" },
    { from: "worker", to: "db", label: "write" },
  ],
  groups: [{ label: "Backend", nodeIds: ["api", "queue", "worker"] }],
}

type RenderOptions = {
  raw?: RawFlowDiagram
  runner?: ElkRunner
  canOpenFile?: (path: string) => boolean
  onOpenFile?: (path: string) => void
}

function renderFlow({
  raw = QUEUE_ROLLOUT,
  runner = runElkInProcess,
  canOpenFile = () => true,
  onOpenFile = vi.fn(),
}: RenderOptions) {
  const diagram = normalizeFlowDiagram(raw)
  return render(
    withLayout(
      runner,
      <DiagramView
        diagram={diagram}
        streaming={false}
        canOpenFile={canOpenFile}
        onOpenFile={onOpenFile}
      />
    )
  )
}

describe("DiagramView draws what the agent sent", () => {
  it("a flow diagram draws every node and edge, and marks added, removed and changed objects with a badge and a ledger row", async () => {
    // Arrange
    const raw = QUEUE_ROLLOUT

    // Act
    renderFlow({ raw })
    const picture = await screen.findByRole("group", { name: /Order dispatch moves to a queue/ })

    // Assert
    const svg = within(picture)
    const ledgerRows = within(screen.getByRole("region", { name: "Changes" })).getAllByRole(
      "listitem"
    )
    expect({
      nodeNames: ["Orders API", "Job queue", "Dispatch worker", "Legacy mailer", "Orders DB"].every(
        (name) => svg.queryAllByText(name).length > 0
      ),
      drawnEdges: picture.querySelectorAll("path[marker-end]").length,
      badges: ["+", "Δ", "−"].map((glyph) => svg.queryAllByText(glyph).length),
      ledger: ledgerRows.map((row) => row.textContent),
    }).toEqual({
      nodeNames: true,
      drawnEdges: 4,
      badges: [4, 1, 2],
      ledger: [
        "CHANGEDOrders APIdirect dispatch → enqueuesrc/api/orders.ts",
        "ADDEDJob queuenew",
        "ADDEDDispatch workersrc/jobs/dispatch.ts",
        "REMOVEDLegacy mailerreplaced by worker",
        "ADDEDOrders API → Job queueenqueue",
        "ADDEDJob queue → Dispatch workerconsume",
        "REMOVEDOrders API → Legacy mailersend",
      ],
    })
  })

  it("past the caps the diagram says how many it left out", async () => {
    // Arrange
    const nodes = Array.from({ length: 23 }, (_, index) => ({
      id: `n${index}`,
      label: `Part ${index}`,
    }))
    const raw: RawFlowDiagram = { title: "Big", nodes, edges: [], groups: [] }

    // Act
    renderFlow({ raw })
    await screen.findByRole("img", { name: /Big/ })

    // Assert
    expect(screen.getByText("Showing 16 of 23 components")).toBeInTheDocument()
  })
})

describe("DiagramView follows the block's width", () => {
  it("a block 720 px wide lays the diagram out left to right, one narrower top to bottom", async () => {
    // Arrange
    const measureAs = (width: number) =>
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width)

    // Act
    measureAs(720)
    const wide = renderFlow({})
    const widePicture = await screen.findByRole("group", { name: /Order dispatch/ })
    const wideBox = widePicture.getAttribute("viewBox")
    wide.unmount()
    measureAs(719)
    renderFlow({})
    const narrowPicture = await screen.findByRole("group", { name: /Order dispatch/ })
    const narrowBox = narrowPicture.getAttribute("viewBox")
    vi.restoreAllMocks()

    // Assert
    const isWide = (viewBox: string | null) => {
      const [, , width = 0, height = 0] = (viewBox ?? "").split(" ").map(Number)
      return width > height
    }
    expect({ at720: isWide(wideBox), at719: isWide(narrowBox) }).toEqual({
      at720: true,
      at719: false,
    })
  })
})

describe("DiagramView prefers a layout that fits", () => {
  it("a 720 px block shows a long chain top to bottom when left to right would have to scroll", async () => {
    // Arrange
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720)
    const nodes = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index}`,
      label: `Stage ${index}`,
    }))
    const edges = nodes.slice(1).map((node, index) => ({ from: `n${index}`, to: node.id }))
    const raw: RawFlowDiagram = { title: "Long chain", nodes, edges, groups: [] }

    const runner = vi.fn(runElkInProcess)

    // Act
    renderFlow({ raw, runner })
    await waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const picture = screen.getByRole("img", { name: /Long chain/ })

    // Assert
    const [, , width = 0, height = 0] = (picture.getAttribute("viewBox") ?? "")
      .split(" ")
      .map(Number)
    vi.restoreAllMocks()
    expect({ tall: height > width, fitsWithoutScrolling: width * 0.8 <= 720 }).toEqual({
      tall: true,
      fitsWithoutScrolling: true,
    })
  })
})

describe("DiagramView lays a diagram out at most twice", () => {
  it("runs at most two layouts however the block's width moves back and forth", async () => {
    // Arrange
    let blockWidth = 800
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => blockWidth)
    const observers: Array<() => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly onResize: () => void
        constructor(onResize: () => void) {
          this.onResize = onResize
        }
        observe() {
          observers.push(this.onResize)
        }
        disconnect() {}
        unobserve() {}
      }
    )
    const resizeTo = (width: number) =>
      act(async () => {
        blockWidth = width
        observers.forEach((onResize) => onResize())
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    const nodes = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index}`,
      label: `Stage ${index}`,
    }))
    const edges = nodes.slice(1).map((node, index) => ({ from: `n${index}`, to: node.id }))
    const raw: RawFlowDiagram = { title: "Long chain", nodes, edges, groups: [] }
    const runner = vi.fn(runElkInProcess)
    const widthsDraggedThrough = [600, 800, 600, 800, 1200, 600, 800]

    // Act
    renderFlow({ raw, runner })
    await waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
    await resizeTo(800)
    for (const width of widthsDraggedThrough) await resizeTo(width)
    const layoutRuns = runner.mock.calls.length
    vi.unstubAllGlobals()
    vi.restoreAllMocks()

    // Assert
    const maxLayoutRuns = 2
    expect(layoutRuns).toBeLessThanOrEqual(maxLayoutRuns)
  })
})

describe("DiagramView opens PR files from nodes", () => {
  it("a node whose path is a PR file opens that file on click and on Enter, and one that is not is not focusable", async () => {
    // Arrange
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    const prFile = "src/api/orders.ts"
    renderFlow({ canOpenFile: (path) => path === prFile, onOpenFile })
    await screen.findByRole("group", { name: /Order dispatch/ })
    const openableNode = screen.getByRole("button", { name: "Orders API, open src/api/orders.ts" })

    // Act
    await user.click(openableNode)
    openableNode.focus()
    await user.keyboard("{Enter}")

    // Assert
    const foreignNode = screen.queryByRole("button", { name: /Dispatch worker/ })
    expect({ opened: onOpenFile.mock.calls, foreignNode }).toEqual({
      opened: [
        [prFile, null],
        [prFile, null],
      ],
      foreignNode: null,
    })
  })
})

describe("DiagramView never turns agent text into markup", () => {
  it("a label containing <script> or <image href> is drawn as text and the SVG holds no loading or linking element", async () => {
    // Arrange
    const scriptLabel = '<script>alert("x")</script>'
    const imageLabel = '<image href="https://tracker.example/p.png"/>'
    const raw: RawFlowDiagram = {
      title: "<svg onload=alert(1)>",
      nodes: [
        { id: "a", label: scriptLabel, change: "added" },
        { id: "b", label: imageLabel },
        { id: "c", label: "Linked", path: "javascript:alert(1)" },
      ],
      edges: [{ from: "a", to: "b", label: '<a href="x">go</a>' }],
      groups: [{ label: "<foreignObject>", nodeIds: ["a"] }],
    }

    // Act
    renderFlow({ raw })
    const picture = await screen.findByRole("group")

    // Assert
    const forbidden = picture.querySelectorAll(
      "script, foreignObject, image, use, a, [href], [xlink\\:href]"
    )
    expect({
      forbiddenElements: forbidden.length,
      scriptShownAsText: within(picture).queryAllByText(scriptLabel).length > 0,
      imageShownAsText: within(picture).queryAllByText(imageLabel).length > 0,
    }).toEqual({ forbiddenElements: 0, scriptShownAsText: true, imageShownAsText: true })
  })
})

describe("DiagramView never leaves a blank box", () => {
  it("a layout failure shows the relationships as a plain list and keeps the ledger", async () => {
    // Arrange
    const runner = failingRunner

    // Act
    renderFlow({ runner })
    await screen.findByText("The diagram could not be laid out. Its relationships:")

    // Assert
    expect({
      relationship: screen.getByText("Orders API → Job queue (enqueue)").tagName,
      ledger: screen.getByRole("region", { name: "Changes" }) !== null,
    }).toEqual({ relationship: "LI", ledger: true })
  })

  it("a block that is still streaming shows a placeholder and lays nothing out", () => {
    // Arrange
    const runner = vi.fn(runElkInProcess)
    const diagram = normalizeFlowDiagram(QUEUE_ROLLOUT)

    // Act
    render(
      withLayout(
        runner,
        <DiagramView diagram={diagram} streaming canOpenFile={() => true} onOpenFile={vi.fn()} />
      )
    )

    // Assert
    expect({
      placeholder: screen.getByRole("status").textContent,
      layoutRuns: runner.mock.calls.length,
    }).toEqual({
      placeholder: "Drawing the diagram when the reply is complete…",
      layoutRuns: 0,
    })
  })
})

const CHECKOUT: RawSequenceDiagram = {
  title: "Checkout request",
  participants: [
    { id: "ui", label: "Checkout UI" },
    { id: "api", label: "Orders API", change: "changed" },
    { id: "queue", label: "Job queue", change: "added" },
  ],
  messages: [
    { from: "ui", to: "api", label: "POST /orders" },
    { from: "api", to: "api", label: "validate cart" },
    { from: "api", to: "queue", label: "enqueue dispatch", change: "added" },
    { from: "api", to: "ui", label: "202 Accepted", reply: true, change: "changed" },
  ],
}

describe("SequenceDiagramView draws messages in order", () => {
  it("draws every participant and message, with badges and a ledger row for each changed object", () => {
    // Arrange
    const sequence = normalizeSequenceDiagram(CHECKOUT)

    // Act
    render(
      <SequenceDiagramView
        sequence={sequence}
        streaming={false}
        canOpenFile={() => false}
        onOpenFile={vi.fn()}
      />
    )

    // Assert
    const picture = screen.getByRole("img", { name: /Checkout request/ })
    const svg = within(picture)
    const ledgerRows = within(screen.getByRole("region", { name: "Changes" })).getAllByRole(
      "listitem"
    )
    expect({
      participants: ["Checkout UI", "Orders API", "Job queue"].every(
        (name) => svg.queryAllByText(name).length > 0
      ),
      messages: ["POST /orders", "validate cart", "enqueue dispatch", "202 Accepted"].every(
        (label) => svg.queryAllByText(label).length > 0
      ),
      arrows: picture.querySelectorAll("path[marker-end]").length,
      ledger: ledgerRows.map((row) => row.textContent),
    }).toEqual({
      participants: true,
      messages: true,
      arrows: 4,
      ledger: [
        "CHANGEDOrders API",
        "ADDEDJob queue",
        "ADDEDOrders API → Job queueenqueue dispatch",
        "CHANGEDOrders API → Checkout UI202 Accepted",
      ],
    })
  })
})

describe("diagrams with nothing to draw, or not complete yet", () => {
  it("a diagram with no components shows a designed empty state, not an empty picture", () => {
    // Arrange
    const raw: RawFlowDiagram = { title: "Summary", nodes: [], edges: [], groups: [] }
    const runner = vi.fn(runElkInProcess)

    // Act
    renderFlow({ raw, runner })

    // Assert
    expect({
      message: screen.getByRole("status").textContent,
      picture: screen.queryByRole("img"),
      layoutRuns: runner.mock.calls.length,
    }).toEqual({ message: "This diagram has no components to draw.", picture: null, layoutRuns: 0 })
  })

  it("a sequence with no participants shows a designed empty state, not an empty picture", () => {
    // Arrange
    const sequence = normalizeSequenceDiagram({ title: "Empty", participants: [], messages: [] })

    // Act
    render(
      <SequenceDiagramView
        sequence={sequence}
        streaming={false}
        canOpenFile={() => false}
        onOpenFile={vi.fn()}
      />
    )

    // Assert
    expect({
      message: screen.getByRole("status").textContent,
      picture: screen.queryByRole("img"),
    }).toEqual({ message: "This sequence has no participants to draw.", picture: null })
  })

  it("a sequence that is still streaming shows a placeholder and draws nothing yet", () => {
    // Arrange
    const sequence = normalizeSequenceDiagram(CHECKOUT)

    // Act
    render(
      <SequenceDiagramView
        sequence={sequence}
        streaming
        canOpenFile={() => false}
        onOpenFile={vi.fn()}
      />
    )

    // Assert
    expect({
      message: screen.getByRole("status").textContent,
      picture: screen.queryByRole("img"),
    }).toEqual({ message: "Drawing the sequence when the reply is complete…", picture: null })
  })
})

describe("the full edge label stays readable", () => {
  it("the ledger row and the fallback list show an edge label longer than 14 characters in full", async () => {
    // Arrange
    const fullLabel = "publishes order events"
    const raw: RawFlowDiagram = {
      title: "Events",
      nodes: [
        { id: "api", label: "Orders API" },
        { id: "bus", label: "Event bus" },
      ],
      edges: [{ from: "api", to: "bus", label: fullLabel, change: "added" }],
      groups: [],
    }

    // Act
    renderFlow({ raw, runner: failingRunner })
    const fallbackLine = await screen.findByText(`Orders API → Event bus (${fullLabel})`)

    // Assert
    const ledger = screen.getByRole("region", { name: "Changes" })
    expect({
      fallback: fallbackLine.tagName,
      ledgerHasFullLabel: ledger.textContent?.includes(fullLabel),
    }).toEqual({ fallback: "LI", ledgerHasFullLabel: true })
  })
})

describe("a node id the agent picks cannot hide the node", () => {
  it("draws a node whose id looks like an internal group id", async () => {
    // Arrange
    const raw: RawFlowDiagram = {
      title: "Ids",
      nodes: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
        { id: "group-0", label: "Gamma", change: "added" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "group-0" },
      ],
      groups: [{ label: "Zone", nodeIds: ["a", "b"] }],
    }

    // Act
    renderFlow({ raw })
    const picture = await screen.findByRole("img", { name: /Ids/ })

    // Assert
    // The drawn names only: the description also lists every name, drawn or not.
    const drawnTexts = [...picture.querySelectorAll("text")].map((text) => text.textContent)
    const drawnNames = ["Alpha", "Beta", "Gamma"].filter((name) => drawnTexts.includes(name))
    expect(drawnNames).toEqual(["Alpha", "Beta", "Gamma"])
  })
})

describe("the picture's role matches what is inside it", () => {
  it("is a group when a node can be opened, and an image when none can", async () => {
    // Arrange
    const prFile = "src/api/orders.ts"

    // Act
    const withOpenableNode = renderFlow({ canOpenFile: (path) => path === prFile })
    const groupPicture = await screen.findByRole("group", { name: /Order dispatch/ })
    const openButtons = within(groupPicture).getAllByRole("button").length
    withOpenableNode.unmount()
    renderFlow({ canOpenFile: () => false })
    const imagePicture = await screen.findByRole("img", { name: /Order dispatch/ })

    // Assert
    expect({
      groupHasOpenButtons: openButtons > 0,
      imageHasNoButtons: within(imagePicture).queryAllByRole("button", { hidden: true }).length,
    }).toEqual({ groupHasOpenButtons: true, imageHasNoButtons: 0 })
  })
})

describe("every name is readable without a mouse", () => {
  it("the picture's description lists every component and participant name in full", async () => {
    // Arrange
    const longName = "Payment reconciliation and settlement batch service"
    const raw: RawFlowDiagram = {
      title: "Names",
      nodes: [
        { id: "a", label: longName },
        { id: "b", label: "Ledger" },
      ],
      edges: [{ from: "a", to: "b" }],
      groups: [],
    }
    const sequence = normalizeSequenceDiagram({
      title: "Steps",
      participants: [
        { id: "a", label: longName },
        { id: "b", label: "Ledger" },
      ],
      messages: [{ from: "a", to: "b", label: "post" }],
    })

    // Act
    renderFlow({ raw, canOpenFile: () => false })
    const flowPicture = await screen.findByRole("img", { name: /Names/ })
    render(
      <SequenceDiagramView
        sequence={sequence}
        streaming={false}
        canOpenFile={() => false}
        onOpenFile={vi.fn()}
      />
    )
    const sequencePicture = screen.getByRole("img", { name: /Steps/ })

    // Assert
    const descriptionOf = (picture: HTMLElement) => picture.querySelector("desc")?.textContent ?? ""
    expect({
      flow: descriptionOf(flowPicture).includes(`Components: ${longName}, Ledger.`),
      sequence: descriptionOf(sequencePicture).includes(`Participants: ${longName}, Ledger.`),
    }).toEqual({ flow: true, sequence: true })
  })
})

describe("a layout that does not finish", () => {
  it("shows the relationship list once a layout has not answered within 5 seconds", async () => {
    // Arrange
    vi.useFakeTimers()
    const neverAnswers: ElkRunner = () => new Promise(() => {})
    const layoutTimeoutMs = 5000

    // Act
    renderFlow({ runner: neverAnswers })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(layoutTimeoutMs)
    })
    const fallback = screen.queryByText("The diagram could not be laid out. Its relationships:")
    vi.useRealTimers()

    // Assert
    expect(fallback).not.toBeNull()
  })

  it("cancels a running layout when the view goes away, and reports nothing as a failure", async () => {
    // Arrange
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const signals: AbortSignal[] = []
    const answersOnlyToAbort: ElkRunner = (_graph, signal) =>
      new Promise((_resolve, reject) => {
        if (signal) signals.push(signal)
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      })
    const layoutTimeoutMs = 5000

    // Act
    const view = renderFlow({ runner: answersOnlyToAbort })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(layoutTimeoutMs)
    })
    const errorsLogged = consoleError.mock.calls.length
    vi.useRealTimers()
    vi.restoreAllMocks()

    // Assert
    expect({
      runStarted: signals.length > 0,
      runCancelled: signals.every((signal) => signal.aborted),
      errorsLogged,
    }).toEqual({ runStarted: true, runCancelled: true, errorsLogged: 0 })
  })
})

describe("a long sequence message", () => {
  it("is drawn cut short, with its full text in the picture's title and in the ledger", () => {
    // Arrange
    const fullLabel =
      "enqueue the dispatch job with three retries and an exponential backoff of two seconds"
    const sequence = normalizeSequenceDiagram({
      title: "Retries",
      participants: [
        { id: "api", label: "Orders API" },
        { id: "queue", label: "Job queue" },
      ],
      messages: [{ from: "api", to: "queue", label: fullLabel, change: "added" }],
    })

    // Act
    render(
      <SequenceDiagramView
        sequence={sequence}
        streaming={false}
        canOpenFile={() => false}
        onOpenFile={vi.fn()}
      />
    )

    // Assert
    const picture = screen.getByRole("img", { name: /Retries/ })
    const drawnLabel = [...picture.querySelectorAll("text")].find((text) =>
      text.textContent?.startsWith("enqueue")
    )
    const titles = [...picture.querySelectorAll("title")].map((title) => title.textContent)
    const ledger = screen.getByRole("region", { name: "Changes" })
    const maxDrawnChars = 40
    expect({
      drawnIsCut: (drawnLabel?.textContent?.length ?? 0) <= maxDrawnChars,
      titleHasFull: titles.includes(fullLabel),
      ledgerHasFull: ledger.textContent?.includes(fullLabel),
    }).toEqual({ drawnIsCut: true, titleHasFull: true, ledgerHasFull: true })
  })
})

describe("a diagram whose nodes have not streamed in yet", () => {
  it("shows the drawing placeholder, not the empty state, for both diagram kinds", () => {
    // Arrange
    const flow = normalizeFlowDiagram({ title: "Arriving", nodes: [], edges: [], groups: [] })
    const sequence = normalizeSequenceDiagram({ title: "Arriving", participants: [], messages: [] })

    // Act
    render(
      <>
        <DiagramView diagram={flow} streaming canOpenFile={() => true} onOpenFile={vi.fn()} />
        <SequenceDiagramView
          sequence={sequence}
          streaming
          canOpenFile={() => true}
          onOpenFile={vi.fn()}
        />
      </>
    )

    // Assert
    const messages = screen.getAllByRole("status").map((status) => status.textContent)
    expect(messages).toEqual([
      "Drawing the diagram when the reply is complete…",
      "Drawing the sequence when the reply is complete…",
    ])
  })
})

describe("a group's name stays inside its group", () => {
  it.each([
    ["a long name around one short node", "Backend services and workers"],
    ["one 400-character word", "x".repeat(400)],
  ])("fits %s, letter spacing counted", async (_case, groupLabel) => {
    // Arrange
    const raw: RawFlowDiagram = {
      title: "Zones",
      nodes: [
        { id: "a", label: "API" },
        { id: "b", label: "DB" },
      ],
      edges: [{ from: "a", to: "b" }],
      groups: [{ label: groupLabel, nodeIds: ["a"] }],
    }

    // Act
    renderFlow({ raw, canOpenFile: () => false })
    const picture = await screen.findByRole("img", { name: /Zones/ })

    // Assert
    const numberOf = (element: Element | null, name: string) =>
      Number(element?.getAttribute(name) ?? Number.NaN)
    const zone = picture.querySelector(`rect.${styles["groupZone"]}`)
    const mask = picture.querySelector(`rect.${styles["eyebrowMask"]}`)
    const zoneRight = numberOf(zone, "x") + numberOf(zone, "width")
    const maskRight = numberOf(mask, "x") + numberOf(mask, "width")
    expect(maskRight).toBeLessThanOrEqual(zoneRight)
  })
})

describe("a layout cancelled while the view is hidden", () => {
  it("is laid out again when the view shows, never reported as a failure", async () => {
    // Arrange
    let runs = 0
    const firstRunWaitsForAbort: ElkRunner = (graph, signal) => {
      runs += 1
      if (runs > 1) return runElkInProcess(graph)

      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      })
    }
    const diagram = normalizeFlowDiagram(QUEUE_ROLLOUT)
    const view = (mode: "visible" | "hidden") =>
      withLayout(
        firstRunWaitsForAbort,
        <Activity mode={mode}>
          <DiagramView
            diagram={diagram}
            streaming={false}
            canOpenFile={() => false}
            onOpenFile={vi.fn()}
          />
        </Activity>
      )

    // Act
    const { rerender } = render(view("visible"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    // Hidden long enough for the cancelled run's rejection to land, as when a tab is switched away.
    await act(async () => {
      rerender(view("hidden"))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    rerender(view("visible"))
    const picture = await screen.findByRole("img", { name: /Order dispatch/ })

    // Assert
    expect({
      drawn: picture !== null,
      fallback: screen.queryByText("The diagram could not be laid out. Its relationships:"),
    }).toEqual({ drawn: true, fallback: null })
  })
})
