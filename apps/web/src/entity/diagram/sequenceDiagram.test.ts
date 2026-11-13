import { describe, expect, it } from "vitest"

import {
  type RawSequenceDiagram,
  type SequenceDiagram,
  normalizeSequenceDiagram,
} from "./sequenceDiagram"

function rawSequence(overrides: Partial<RawSequenceDiagram>): RawSequenceDiagram {
  return { title: "Checkout", participants: [], messages: [], ...overrides }
}

describe("normalizeSequenceDiagram keeps what the agent sent", () => {
  it("reads participants and messages in order, with change and reply", () => {
    // Arrange
    const raw = rawSequence({
      participants: [
        { id: "ui", label: "Checkout UI" },
        { id: "api", label: "Orders API", change: "changed" },
      ],
      messages: [
        { from: "ui", to: "api", label: "POST /orders", change: "changed" },
        { from: "api", to: "ui", label: "201 Created", reply: true },
      ],
    })

    // Act
    const sequence = normalizeSequenceDiagram(raw)

    // Assert
    const expected: SequenceDiagram = {
      title: "Checkout",
      participants: [
        { id: "ui", label: "Checkout UI", change: "unchanged" },
        { id: "api", label: "Orders API", change: "changed" },
      ],
      messages: [
        {
          id: "message-0",
          from: "ui",
          to: "api",
          label: "POST /orders",
          change: "changed",
          reply: false,
        },
        {
          id: "message-1",
          from: "api",
          to: "ui",
          label: "201 Created",
          change: "unchanged",
          reply: true,
        },
      ],
      notices: [],
    }
    expect(sequence).toEqual(expected)
  })
})

describe("normalizeSequenceDiagram tolerates model mistakes and caps visibly", () => {
  it("creates a participant for a message to an unknown id", () => {
    // Arrange
    const raw = rawSequence({
      participants: [{ id: "ui", label: "UI" }],
      messages: [{ from: "ui", to: "worker", label: "enqueue" }],
    })

    // Act
    const sequence = normalizeSequenceDiagram(raw)

    // Assert
    expect(sequence.participants.map((participant) => participant.id)).toEqual(["ui", "worker"])
  })

  it("keeps the first 8 participants and 24 messages and reports the totals", () => {
    // Arrange
    const participants = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}` }))
    const messages = Array.from({ length: 30 }, (_, index) => ({
      from: "p0",
      to: `p${(index % 7) + 1}`,
      label: `step ${index}`,
    }))

    // Act
    const sequence = normalizeSequenceDiagram(rawSequence({ participants, messages }))

    // Assert
    expect({
      participants: sequence.participants.length,
      messages: sequence.messages.length,
      notices: sequence.notices,
    }).toEqual({
      participants: 8,
      messages: 24,
      notices: ["Showing 8 of 10 participants", "Showing 24 of 30 messages"],
    })
  })
})

describe("normalizeSequenceDiagram draws no column a message past the cap would have made", () => {
  it("creates no participant named only by messages past the message cap", () => {
    // Arrange
    const messageCap = 24
    const messagesInsideCap = Array.from({ length: messageCap }, () => ({
      from: "ui",
      to: "api",
      label: "poll",
    }))
    const raw = rawSequence({
      participants: [
        { id: "ui", label: "UI" },
        { id: "api", label: "API" },
      ],
      messages: [...messagesInsideCap, { from: "api", to: "audit", label: "log" }],
    })

    // Act
    const sequence = normalizeSequenceDiagram(raw)

    // Assert
    const expected = ["ui", "api"]
    expect(sequence.participants.map((participant) => participant.id)).toEqual(expected)
  })
})
