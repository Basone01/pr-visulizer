import { describe, expect, it } from "vitest"

import { layoutSequence } from "@/utils/diagram/sequenceLayout"

import {
  NODE_MAX_WIDTH,
  NODE_MIN_WIDTH,
  edgeLabelBox,
  edgeLabelText,
  flowNodeBoxes,
  participantBoxes,
  sequenceLayoutInput,
} from "./diagramBoxes"
import { type FlowNode, normalizeFlowDiagram } from "./flowDiagram"
import { normalizeSequenceDiagram } from "./sequenceDiagram"

const GRID = 4

function rawNode(id: string, label: string, path: string | null = null): Partial<FlowNode> {
  return { id, label, path }
}

describe("diagram boxes are sized to their content", () => {
  it("gives a short label a narrower node than a long one, on the 4 px grid and within the bounds", () => {
    // Arrange
    const diagram = normalizeFlowDiagram({
      title: "Sizes",
      nodes: [
        rawNode("db", "DB"),
        rawNode("api", "Orders API"),
        rawNode("checkout", "Checkout screen", "src/ui/CheckoutScreenContainer.tsx"),
        rawNode("long", "A component whose name is far too long to fit on a single line"),
      ],
      edges: [],
      groups: [],
    })

    // Act
    const widths = flowNodeBoxes(diagram).map((box) => box.width)

    // Assert
    const [db = 0, api = 0, checkout = 0, long = 0] = widths
    expect({
      shortIsMinimum: db === NODE_MIN_WIDTH,
      growsWithContent: db <= api && api < checkout && checkout <= long,
      longIsMaximum: long === NODE_MAX_WIDTH,
      onGrid: widths.every((width) => width % GRID === 0),
    }).toEqual({ shortIsMinimum: true, growsWithContent: true, longIsMaximum: true, onGrid: true })
  })

  it("keeps two lifelines close for a short message and moves them apart for a long one", () => {
    // Arrange
    const sequence = normalizeSequenceDiagram({
      title: "Gaps",
      participants: [
        { id: "ui", label: "UI" },
        { id: "api", label: "API" },
        { id: "queue", label: "Queue" },
      ],
      messages: [
        { from: "ui", to: "api", label: "GET" },
        { from: "api", to: "queue", label: "enqueue the dispatch job with retries" },
      ],
    })
    const input = sequenceLayoutInput(sequence, participantBoxes(sequence))

    // Act
    const layout = layoutSequence(input.columns, input.rows)

    // Assert
    const [ui, api, queue] = layout.columns.map((column) => column.center)
    const shortGap = (api ?? 0) - (ui ?? 0)
    const longGap = (queue ?? 0) - (api ?? 0)
    const longLabelWidth = input.rows[1]?.labelWidth ?? 0
    expect({
      shortGapIsTight: shortGap < 120,
      longGapFitsItsLabel: longGap >= longLabelWidth,
    }).toEqual({ shortGapIsTight: true, longGapFitsItsLabel: true })
  })

  it("draws an edge label cut to 14 characters, in upper case", () => {
    // Arrange
    const label = "publishes events to"

    // Act
    const drawn = edgeLabelText(label)

    // Assert
    const expected = "PUBLISHES EVE…"
    expect(drawn).toBe(expected)
  })

  it("breaks an edge label after a slash or a dash, keeping the separator on the first line", () => {
    // Arrange
    const labels = ["create/update", "read-through", "a/b"]

    // Act
    const lines = labels.map((label) => edgeLabelBox(label, "unchanged").lines)

    // Assert
    const expected = [["CREATE/", "UPDATE"], ["READ-", "THROUGH"], ["A/B"]]
    expect(lines).toEqual(expected)
  })
})
