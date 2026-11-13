import { describe, expect, it } from "vitest"

import { wrapText } from "@/utils/diagram/textMetrics"

import {
  flowLayeredGraph,
  flowNodeBoxes,
  participantBoxes,
  sequenceLayoutInput,
} from "./diagramBoxes"
import { TEXT_BUDGETS } from "./diagramModel"
import { normalizeFlowDiagram } from "./flowDiagram"
import { normalizeSequenceDiagram } from "./sequenceDiagram"

// A hash or a minified path copied from a hostile PR is one unbroken word. Measuring it must stay
// cheap: the readers cut every string to a budget, and wrapping is linear.
const HUGE_WORD = "x".repeat(100_000)
const TIME_BUDGET_MS = 50

describe("agent strings are cut to a budget before anything measures them", () => {
  it("normalizes and sizes a diagram of 100,000-character words in under 50 ms", () => {
    // Arrange
    const rawFlow = {
      title: HUGE_WORD,
      nodes: [{ id: HUGE_WORD, label: HUGE_WORD, note: HUGE_WORD, path: `src/${HUGE_WORD}.ts` }],
      edges: [{ from: HUGE_WORD, to: "b", label: HUGE_WORD }],
      groups: [{ label: HUGE_WORD, nodeIds: ["b"] }],
    }
    const rawSequence = {
      title: HUGE_WORD,
      participants: [
        { id: "a", label: HUGE_WORD },
        { id: "b", label: "B" },
      ],
      messages: [{ from: "a", to: "b", label: HUGE_WORD }],
    }

    // Act
    const started = performance.now()
    const flow = normalizeFlowDiagram(rawFlow)
    flowLayeredGraph(flow, flowNodeBoxes(flow))
    const sequence = normalizeSequenceDiagram(rawSequence)
    sequenceLayoutInput(sequence, participantBoxes(sequence))
    const elapsedMs = performance.now() - started

    // Assert
    expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS)
  })
})

describe("each half of the budget holds on its own", () => {
  it("the readers keep at most each field's budget of characters", () => {
    // Arrange
    const huge = "y".repeat(100_000)
    const raw = {
      title: huge,
      nodes: [{ id: huge, label: huge, note: huge, path: huge }],
      edges: [{ from: huge, to: huge, label: huge }],
      groups: [{ label: huge, nodeIds: [huge] }],
    }

    // Act
    const diagram = normalizeFlowDiagram(raw)

    // Assert
    const node = diagram.nodes[0]
    const lengthOf = (text: string | null | undefined) => Array.from(text ?? "").length
    expect({
      title: lengthOf(diagram.title) <= TEXT_BUDGETS.title,
      id: lengthOf(node?.id) <= TEXT_BUDGETS.id,
      label: lengthOf(node?.label) <= TEXT_BUDGETS.label,
      note: lengthOf(node?.note) <= TEXT_BUDGETS.note,
      path: lengthOf(node?.path) <= TEXT_BUDGETS.path,
      edgeLabel: lengthOf(diagram.edges[0]?.label) <= TEXT_BUDGETS.label,
      groupLabel: lengthOf(diagram.groups[0]?.label) <= TEXT_BUDGETS.label,
    }).toEqual({
      title: true,
      id: true,
      label: true,
      note: true,
      path: true,
      edgeLabel: true,
      groupLabel: true,
    })
  })

  it("wrapping one 100,000-character word into two lines takes under 50 ms without any budget", () => {
    // Arrange
    const word = "z".repeat(100_000)
    const maxWidth = 176
    const fontSize = 12
    const maxLines = 2

    // Act
    const started = performance.now()
    const wrapped = wrapText(word, maxWidth, fontSize, "sans", maxLines)
    const elapsedMs = performance.now() - started

    // Assert
    expect({ fast: elapsedMs < TIME_BUDGET_MS, lines: wrapped.lines.length }).toEqual({
      fast: true,
      lines: maxLines,
    })
  })

  it("padding of spaces and bidi controls before a label does not use up its budget", () => {
    // Arrange
    const padding = " ".repeat(300) + "\u202e\u2066".repeat(100)
    const raw = { title: "T", nodes: [{ id: "a", label: `${padding}Orders API` }], edges: [] }

    // Act
    const diagram = normalizeFlowDiagram({ ...raw, groups: [] })

    // Assert
    expect(diagram.nodes[0]?.label).toBe("Orders API")
  })
})
